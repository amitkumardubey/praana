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
        model_dir.join("onnx/model.onnx"),
        model_dir.join("model.onnx"),
        model_dir.join("onnx/model_quantized.onnx"),
        model_dir.join("model_quantized.onnx"),
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
    fn cache_keys_detect_changes_and_evict_oldest() {
        use std::fs::{self, File, FileTimes};
        let root = tempfile::tempdir().unwrap();
        let make = |name: &str| {
            let dir = root.path().join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("tokenizer.json"), b"tokenizer").unwrap();
            fs::write(dir.join("model.onnx"), b"model").unwrap();
            dir
        };
        let a = make("a");
        let b = make("b");
        let c = make("c");
        let key = |dir: &Path| CacheKey::read(dir, &dir.join("model.onnx")).unwrap();
        let original = key(&a);
        assert_eq!(original, key(&a.join(".")));
        let mut cache = Cache(VecDeque::new());
        cache.insert(original.clone(), Arc::new(1));
        assert_eq!(*cache.get(&original).unwrap(), 1);
        fs::write(a.join("model.onnx"), b"longer model").unwrap();
        let changed_len = key(&a);
        assert_ne!(original, changed_len);
        assert!(cache.get(&changed_len).is_none());
        let file = File::options()
            .write(true)
            .open(a.join("model.onnx"))
            .unwrap();
        file.set_times(
            FileTimes::new()
                .set_modified(changed_len.weights.modified + std::time::Duration::from_secs(5)),
        )
        .unwrap();
        let changed_time = key(&a);
        assert_ne!(changed_len, changed_time);
        cache.insert(changed_time.clone(), Arc::new(2));
        assert_eq!(cache.0.len(), 1);
        fs::write(a.join("tokenizer.json"), b"changed tokenizer").unwrap();
        assert_ne!(changed_time, key(&a));
        cache.insert(key(&b), Arc::new(3));
        cache.insert(key(&c), Arc::new(4));
        assert!(cache.get(&changed_time).is_none());
        assert!(cache.get(&key(&b)).is_some());
        assert!(cache.get(&key(&c)).is_some());
        assert_eq!(cache.0.len(), 2);
    }

    #[test]
    fn missing_onnx_reports_original_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tokenizer.json"), b"unused").unwrap();
        let error = embed_text("hello", dir.path()).unwrap_err();
        assert_eq!(error.code.as_str(), "unavailable");
        assert_eq!(
            error.message,
            format!("ONNX model not found in {}", dir.path().display())
        );
    }

    #[test]
    #[ignore]
    fn cached_embedding_matches_and_is_fast() {
        let dir = std::env::var_os("PRAANA_TEST_MODEL_DIR").expect("PRAANA_TEST_MODEL_DIR");
        let dir = Path::new(&dir);
        let start = std::time::Instant::now();
        let first = embed_text("A small embedding benchmark.", dir).unwrap();
        let first_time = start.elapsed();
        let start = std::time::Instant::now();
        let second = embed_text("A small embedding benchmark.", dir).unwrap();
        let second_time = start.elapsed();
        eprintln!("first: {first_time:?}, second: {second_time:?}");
        let baseline = embed_text_uncached("A small embedding benchmark.", dir).unwrap();
        assert_eq!(first.embedding, baseline.embedding);
        assert_eq!(first.dim, baseline.dim);
        assert_eq!(first.embedding, second.embedding);
        assert_eq!(first.dim, second.dim);
        assert!(second_time <= first_time.mul_f64(1.2));
    }

    #[test]
    fn missing_model_dir_errors() {
        let r = embed_text("hello", Path::new("/tmp/praana-no-such-model"));
        assert_eq!(r.unwrap_err().code.as_str(), "unavailable");
    }

    #[test]
    fn find_onnx_prefers_full_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("onnx")).unwrap();
        for name in [
            "onnx/model.onnx",
            "model.onnx",
            "onnx/model_quantized.onnx",
            "model_quantized.onnx",
        ] {
            std::fs::write(dir.path().join(name), b"").unwrap();
        }
        assert_eq!(
            find_onnx(dir.path()),
            Some(dir.path().join("onnx/model.onnx"))
        );
        std::fs::remove_file(dir.path().join("onnx/model.onnx")).unwrap();
        assert_eq!(find_onnx(dir.path()), Some(dir.path().join("model.onnx")));
    }

    #[test]
    fn find_onnx_finds_quantized_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("onnx")).unwrap();
        let model = dir.path().join("onnx/model_quantized.onnx");
        std::fs::write(&model, b"").unwrap();
        assert_eq!(find_onnx(dir.path()), Some(model));
    }

    #[test]
    fn find_onnx_none_on_empty() {
        assert!(find_onnx(Path::new("/tmp/definitely-missing-praana-embed")).is_none());
    }
}
