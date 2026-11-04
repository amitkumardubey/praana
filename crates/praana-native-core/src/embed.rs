//! Tokenization and ONNX embedding (moved from the N-API wrapper).
//!
//! Gated behind the `embeddings` feature so future Rust binaries do not pull
//! the ONNX/tokenizer dependency tree by default.
#![cfg(feature = "embeddings")]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use ndarray::Array2;
use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

use crate::error::{NativeError, NativeErrorCode, NativeResult};
use crate::types::EmbedOutput;

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

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileStamp {
    len: u64,
    modified: SystemTime,
}

impl FileStamp {
    fn read(path: &Path) -> std::io::Result<Self> {
        let metadata = path.metadata()?;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified()?,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CacheKey {
    dir: PathBuf,
    onnx: PathBuf,
    weights: FileStamp,
    tokenizer: FileStamp,
}

impl CacheKey {
    fn read(dir: &Path, onnx: &Path) -> std::io::Result<Self> {
        Ok(Self {
            dir: dir.canonicalize()?,
            onnx: onnx.canonicalize()?,
            weights: FileStamp::read(onnx)?,
            tokenizer: FileStamp::read(&dir.join("tokenizer.json"))?,
        })
    }
}

struct Cache<T>(VecDeque<(CacheKey, Arc<T>)>);
impl<T> Cache<T> {
    fn get(&self, key: &CacheKey) -> Option<Arc<T>> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| Arc::clone(v))
    }
    fn insert(&mut self, key: CacheKey, value: Arc<T>) {
        // A new generation replaces the stale generation of the same directory.
        self.0.retain(|(k, _)| k.dir != key.dir);
        while self.0.len() >= 2 {
            self.0.pop_front();
        }
        self.0.push_back((key, value));
    }
}

struct Loaded {
    tokenizer: Tokenizer,
    model: TypedRunnableModel<TypedModel>,
    arity: AtomicU8,
}

static CACHE: OnceLock<Mutex<Cache<Loaded>>> = OnceLock::new();

fn load(tokenizer_path: &Path, onnx_path: &Path) -> NativeResult<Loaded> {
    let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
        NativeError::new(
            NativeErrorCode::Internal,
            format!("tokenizer load failed: {e}"),
        )
    })?;
    let model = tract_onnx::onnx().model_for_path(onnx_path).map_err(|e| {
        NativeError::new(NativeErrorCode::Internal, format!("onnx load failed: {e}"))
    })?;
    let model = model.into_optimized().map_err(|e| {
        NativeError::new(
            NativeErrorCode::Internal,
            format!("onnx optimize failed: {e}"),
        )
    })?;
    let model = model.into_runnable().map_err(|e| {
        NativeError::new(
            NativeErrorCode::Internal,
            format!("onnx runnable failed: {e}"),
        )
    })?;
    Ok(Loaded {
        tokenizer,
        model,
        arity: AtomicU8::new(0),
    })
}

pub fn embed_text(text: &str, model_dir: &Path) -> NativeResult<EmbedOutput> {
    embed_text_impl(text, model_dir, true)
}

#[cfg(test)]
fn embed_text_uncached(text: &str, model_dir: &Path) -> NativeResult<EmbedOutput> {
    embed_text_impl(text, model_dir, false)
}

fn embed_text_impl(text: &str, model_dir: &Path, cached: bool) -> NativeResult<EmbedOutput> {
    let dir = model_dir.to_path_buf();
    let tokenizer_path = dir.join("tokenizer.json");
    if !tokenizer_path.is_file() {
        return Err(NativeError::new(
            NativeErrorCode::Unavailable,
            format!("tokenizer.json not found in {}", dir.display()),
        ));
    }
    let onnx_path = find_onnx(&dir).ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::Unavailable,
            format!("ONNX model not found in {}", dir.display()),
        )
    })?;

    let key = cached
        .then(|| CacheKey::read(&dir, &onnx_path).ok())
        .flatten();
    let loaded = if let Some(key) = key {
        let mut cache = CACHE
            .get_or_init(|| Mutex::new(Cache(VecDeque::new())))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(loaded) = cache.get(&key) {
            loaded
        } else {
            let loaded = Arc::new(load(&tokenizer_path, &onnx_path)?);
            cache.insert(key, Arc::clone(&loaded));
            loaded
        }
    } else {
        Arc::new(load(&tokenizer_path, &onnx_path)?)
    };
    let encoding = loaded.tokenizer.encode(text, true).map_err(|e| {
        NativeError::new(NativeErrorCode::Internal, format!("tokenize failed: {e}"))
    })?;
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

    let id_tensor: Tensor = tract_ndarray::Array2::from_shape_vec((1, seq), ids.clone())
        .map_err(|e| NativeError::new(NativeErrorCode::Internal, format!("tensor ids: {e}")))?
        .into();
    let mask_tensor: Tensor = tract_ndarray::Array2::from_shape_vec((1, seq), mask.clone())
        .map_err(|e| NativeError::new(NativeErrorCode::Internal, format!("tensor mask: {e}")))?
        .into();
    let type_tensor: Tensor = tract_ndarray::Array2::from_shape_vec((1, seq), types)
        .map_err(|e| NativeError::new(NativeErrorCode::Internal, format!("tensor types: {e}")))?
        .into();

    let inputs: TVec<TValue> = tvec!(id_tensor.into(), mask_tensor.into(), type_tensor.into(),);
    let two_inputs = || {
        let ids: Tensor = tract_ndarray::Array2::from_shape_vec((1, seq), ids.clone())
            .unwrap()
            .into();
        let mask: Tensor = tract_ndarray::Array2::from_shape_vec((1, seq), mask.clone())
            .unwrap()
            .into();
        loaded.model.run(tvec!(ids.into(), mask.into()))
    };
    // If a previously successful two-input run fails, retry the original path
    // so the reported error still comes from the three-input attempt.
    let fast = if loaded.arity.load(Ordering::Relaxed) == 2 {
        two_inputs().ok()
    } else {
        None
    };
    let outputs = if let Some(outputs) = fast {
        outputs
    } else {
        match loaded.model.run(inputs) {
            Ok(o) => {
                loaded.arity.store(3, Ordering::Relaxed);
                o
            }
            Err(e) => {
                // some models only take 2 inputs
                let id_tensor: Tensor =
                    tract_ndarray::Array2::from_shape_vec((1, seq), ids.clone())
                        .map_err(|e2| {
                            NativeError::new(NativeErrorCode::Internal, format!("tensor ids: {e2}"))
                        })?
                        .into();
                let mask_tensor: Tensor =
                    tract_ndarray::Array2::from_shape_vec((1, seq), mask.clone())
                        .map_err(|e2| {
                            NativeError::new(
                                NativeErrorCode::Internal,
                                format!("tensor mask: {e2}"),
                            )
                        })?
                        .into();
                let outputs = loaded
                    .model
                    .run(tvec!(id_tensor.into(), mask_tensor.into()))
                    .map_err(|_| {
                        NativeError::new(NativeErrorCode::Internal, format!("onnx run failed: {e}"))
                    })?;
                loaded.arity.store(2, Ordering::Relaxed);
                outputs
            }
        }
    };

    let first = outputs
        .into_iter()
        .next()
        .ok_or_else(|| NativeError::new(NativeErrorCode::Internal, "onnx produced no outputs"))?;
    let array = first
        .to_array_view::<f32>()
        .map_err(|e| NativeError::new(NativeErrorCode::Internal, format!("onnx output: {e}")))?;
    let array = array.to_owned();

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
        Array2::from_shape_vec((seq_len, dim), data)
            .map_err(|e| NativeError::new(NativeErrorCode::Internal, format!("reshape: {e}")))?
    } else if array.ndim() == 2 {
        Array2::from_shape_vec(
            (array.shape()[0], array.shape()[1]),
            array.iter().copied().collect(),
        )
        .map_err(|e| NativeError::new(NativeErrorCode::Internal, format!("reshape: {e}")))?
    } else {
        return Err(NativeError::new(
            NativeErrorCode::Internal,
            format!("unexpected onnx rank {}", array.ndim()),
        ));
    };

    let pooled = mean_pool(&hidden, &mask);
    Ok(EmbedOutput {
        dim: pooled.len() as u32,
        embedding: pooled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_model_dir_errors() {
        let r = embed_text("hello", Path::new("/tmp/praana-no-such-model"));
        assert_eq!(r.unwrap_err().code.as_str(), "unavailable");
    }

    #[test]
    fn find_onnx_none_on_empty() {
        assert!(find_onnx(Path::new("/tmp/definitely-missing-praana-embed")).is_none());
    }
}
