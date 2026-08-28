use std::path::{Path, PathBuf};

use ndarray::Array2;
use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

use crate::types::EmbedResult;

fn find_onnx(model_dir: &Path) -> Option<PathBuf> {
  let candidates = [
    model_dir.join("onnx/model_quantized.onnx"),
    model_dir.join("onnx/model.onnx"),
    model_dir.join("model_quantized.onnx"),
    model_dir.join("model.onnx"),
  ];
  candidates.into_iter().find(|p| p.is_file())
}

fn mean_pool(hidden: &Array2<f32>, mask: &[i64]) -> Vec<f32> {
  let seq = hidden.nrows();
  let dim = hidden.ncols();
  let mut out = vec![0f32; dim];
  let mut count = 0f32;
  for (i, m) in mask.iter().enumerate().take(seq) {
    if *m == 0 {
      continue;
    }
    count += 1.0;
    for d in 0..dim {
      out[d] += hidden[(i, d)];
    }
  }
  if count > 0.0 {
    for v in out.iter_mut() {
      *v /= count;
    }
  }
  let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
  if norm > 0.0 {
    for v in out.iter_mut() {
      *v /= norm;
    }
  }
  out
}

pub fn embed_text(text: String, model_dir: String) -> EmbedResult {
  let dir = PathBuf::from(&model_dir);
  let tokenizer_path = dir.join("tokenizer.json");
  if !tokenizer_path.is_file() {
    return EmbedResult::err(
      "unavailable",
      format!("tokenizer.json not found in {model_dir}"),
    );
  }
  let onnx_path = match find_onnx(&dir) {
    Some(p) => p,
    None => {
      return EmbedResult::err("unavailable", format!("ONNX model not found in {model_dir}"));
    }
  };

  let tokenizer = match Tokenizer::from_file(&tokenizer_path) {
    Ok(t) => t,
    Err(e) => return EmbedResult::err("internal", format!("tokenizer load failed: {e}")),
  };
  let encoding = match tokenizer.encode(text, true) {
    Ok(e) => e,
    Err(e) => return EmbedResult::err("internal", format!("tokenize failed: {e}")),
  };
  let ids: Vec<i64> = encoding.get_ids().iter().map(|id| *id as i64).collect();
  let mask: Vec<i64> = encoding
    .get_attention_mask()
    .iter()
    .map(|m| *m as i64)
    .collect();
  let types: Vec<i64> = if encoding.get_type_ids().is_empty() {
    vec![0; ids.len()]
  } else {
    encoding.get_type_ids().iter().map(|t| *t as i64).collect()
  };
  let seq = ids.len();

  let model = match tract_onnx::onnx().model_for_path(&onnx_path) {
    Ok(m) => m,
    Err(e) => return EmbedResult::err("internal", format!("onnx load failed: {e}")),
  };
  let model = match model.into_optimized() {
    Ok(m) => m,
    Err(e) => return EmbedResult::err("internal", format!("onnx optimize failed: {e}")),
  };
  let model = match model.into_runnable() {
    Ok(m) => m,
    Err(e) => return EmbedResult::err("internal", format!("onnx runnable failed: {e}")),
  };

  let id_tensor: Tensor = match tract_ndarray::Array2::from_shape_vec((1, seq), ids.clone()) {
    Ok(a) => a.into(),
    Err(e) => return EmbedResult::err("internal", format!("tensor ids: {e}")),
  };
  let mask_tensor: Tensor = match tract_ndarray::Array2::from_shape_vec((1, seq), mask.clone()) {
    Ok(a) => a.into(),
    Err(e) => return EmbedResult::err("internal", format!("tensor mask: {e}")),
  };
  let type_tensor: Tensor = match tract_ndarray::Array2::from_shape_vec((1, seq), types) {
    Ok(a) => a.into(),
    Err(e) => return EmbedResult::err("internal", format!("tensor types: {e}")),
  };

  let inputs: TVec<TValue> = tvec!(
    id_tensor.into(),
    mask_tensor.into(),
    type_tensor.into(),
  );
  let outputs = match model.run(inputs) {
    Ok(o) => o,
    Err(e) => {
      // some models only take 2 inputs
      let id_tensor: Tensor =
        match tract_ndarray::Array2::from_shape_vec((1, seq), ids.clone()) {
          Ok(a) => a.into(),
          Err(e) => return EmbedResult::err("internal", format!("tensor ids: {e}")),
        };
      let mask_tensor: Tensor =
        match tract_ndarray::Array2::from_shape_vec((1, seq), mask.clone()) {
          Ok(a) => a.into(),
          Err(e) => return EmbedResult::err("internal", format!("tensor mask: {e}")),
        };
      match model.run(tvec!(id_tensor.into(), mask_tensor.into())) {
        Ok(o) => o,
        Err(_) => return EmbedResult::err("internal", format!("onnx run failed: {e}")),
      }
    }
  };

  let first = match outputs.into_iter().next() {
    Some(v) => v,
    None => return EmbedResult::err("internal", "onnx produced no outputs"),
  };
  let array = match first.to_array_view::<f32>() {
    Ok(a) => a.to_owned(),
    Err(e) => return EmbedResult::err("internal", format!("onnx output: {e}")),
  };

  // [1, seq, hidden] or [seq, hidden]
  let hidden = if array.ndim() == 3 {
    let seq_len = array.shape()[1];
    let dim = array.shape()[2];
    let mut data = Vec::with_capacity(seq_len * dim);
    for s in 0..seq_len {
      for d in 0..dim {
        data.push(array[[0, s, d]]);
      }
    }
    match Array2::from_shape_vec((seq_len, dim), data) {
      Ok(a) => a,
      Err(e) => return EmbedResult::err("internal", format!("reshape: {e}")),
    }
  } else if array.ndim() == 2 {
    match Array2::from_shape_vec(
      (array.shape()[0], array.shape()[1]),
      array.iter().copied().collect(),
    ) {
      Ok(a) => a,
      Err(e) => return EmbedResult::err("internal", format!("reshape: {e}")),
    }
  } else {
    return EmbedResult::err("internal", format!("unexpected onnx rank {}", array.ndim()));
  };

  let pooled = mean_pool(&hidden, &mask);
  EmbedResult {
    ok: true,
    error: None,
    code: None,
    dim: pooled.len() as u32,
    embedding: pooled.iter().map(|v| *v as f64).collect(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn missing_model_dir_errors() {
    let r = embed_text("hello".into(), "/tmp/praana-no-such-model".into());
    assert!(!r.ok);
    assert_eq!(r.code.as_deref(), Some("unavailable"));
  }

  #[test]
  fn find_onnx_none_on_empty() {
    assert!(find_onnx(Path::new("/tmp/definitely-missing-praana-embed")).is_none());
  }
}
