use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const UNICODE_VERSION: &str = "15.1.0";
pub const UTILITY_VERSION: &str = "praana-unicode-15.1-v1";

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestSourceFile {
    pub byte_count: u64,
    pub filename: String,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestGeneratedFile {
    pub byte_count: u64,
    pub filename: String,
    pub sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub generated_files: Vec<ManifestGeneratedFile>,
    pub source_files: Vec<ManifestSourceFile>,
    pub unicode_version: String,
    pub utility_version: String,
}

pub struct UcdSource {
    pub filename: &'static str,
    pub url: &'static str,
}

pub const UCD_SOURCES: &[UcdSource] = &[
    UcdSource {
        filename: "UnicodeData.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/UnicodeData.txt",
    },
    UcdSource {
        filename: "Scripts.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/Scripts.txt",
    },
    UcdSource {
        filename: "PropList.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/PropList.txt",
    },
    UcdSource {
        filename: "DerivedCoreProperties.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/DerivedCoreProperties.txt",
    },
    UcdSource {
        filename: "emoji-data.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/emoji/emoji-data.txt",
    },
    UcdSource {
        filename: "CaseFolding.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt",
    },
    UcdSource {
        filename: "DerivedNormalizationProps.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/DerivedNormalizationProps.txt",
    },
    UcdSource {
        filename: "NormalizationTest.txt",
        url: "https://www.unicode.org/Public/15.1.0/ucd/NormalizationTest.txt",
    },
];

pub fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.is_empty() {
        eprintln!("Usage: praana-xtask unicode <fetch|generate|verify> [options]");
        return Ok(());
    }

    let core_dir = PathBuf::from("crates/praana-core");
    let ucd_dir = core_dir.join("data/unicode").join(UNICODE_VERSION);
    let source_dir = ucd_dir.join("source");
    let manifest_path = ucd_dir.join("manifest.json");

    match args[0].as_str() {
        "fetch" => {
            fs::create_dir_all(&source_dir)?;
            let mut manifest_sources = Vec::new();

            for src in UCD_SOURCES {
                let target = source_dir.join(src.filename);
                println!("Fetching {} from {} ...", src.filename, src.url);
                let resp = reqwest::blocking::get(src.url)?.error_for_status()?;
                let bytes = resp.bytes()?;
                fs::write(&target, &bytes)?;

                let sha256_hex = format!("{:x}", Sha256::digest(&bytes));
                manifest_sources.push(ManifestSourceFile {
                    byte_count: bytes.len() as u64,
                    filename: src.filename.to_string(),
                    sha256: sha256_hex,
                    url: src.url.to_string(),
                });
            }

            // Generate generated_v15_1.rs and fixture
            let (gen_rs_bytes, fixture_bytes) = generate_artifacts(&source_dir)?;
            let gen_rs_path = core_dir.join("src/unicode/generated_v15_1.rs");
            let fixture_path = core_dir.join("tests/fixtures/unicode_v15_1.json");

            fs::create_dir_all(gen_rs_path.parent().unwrap())?;
            fs::create_dir_all(fixture_path.parent().unwrap())?;
            fs::write(&gen_rs_path, &gen_rs_bytes)?;
            fs::write(&fixture_path, &fixture_bytes)?;

            let gen_files = vec![
                ManifestGeneratedFile {
                    byte_count: gen_rs_bytes.len() as u64,
                    filename: "crates/praana-core/src/unicode/generated_v15_1.rs".to_string(),
                    sha256: format!("{:x}", Sha256::digest(&gen_rs_bytes)),
                },
                ManifestGeneratedFile {
                    byte_count: fixture_bytes.len() as u64,
                    filename: "crates/praana-core/tests/fixtures/unicode_v15_1.json".to_string(),
                    sha256: format!("{:x}", Sha256::digest(&fixture_bytes)),
                },
            ];

            let manifest = Manifest {
                unicode_version: UNICODE_VERSION.to_string(),
                utility_version: UTILITY_VERSION.to_string(),
                source_files: manifest_sources,
                generated_files: gen_files,
            };

            let manifest_json = to_canonical_json(&manifest)? + "\n";
            fs::write(&manifest_path, manifest_json)?;
            println!("Unicode 15.1.0 fetch and generation complete.");
        }
        "generate" => {
            if !args[1..].contains(&"--offline".to_string()) {
                return Err("unicode generate requires --offline flag".into());
            }
            verify_sources(&source_dir, &manifest_path)?;
            let (gen_rs_bytes, fixture_bytes) = generate_artifacts(&source_dir)?;
            let gen_rs_path = core_dir.join("src/unicode/generated_v15_1.rs");
            let fixture_path = core_dir.join("tests/fixtures/unicode_v15_1.json");

            fs::create_dir_all(gen_rs_path.parent().unwrap())?;
            fs::create_dir_all(fixture_path.parent().unwrap())?;
            fs::write(&gen_rs_path, &gen_rs_bytes)?;
            fs::write(&fixture_path, &fixture_bytes)?;

            // Update manifest.json with the generated file hashes and byte counts in RFC 8785 format
            let manifest_bytes = fs::read(&manifest_path)?;
            let mut manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
            manifest.generated_files = vec![
                ManifestGeneratedFile {
                    byte_count: gen_rs_bytes.len() as u64,
                    filename: "crates/praana-core/src/unicode/generated_v15_1.rs".to_string(),
                    sha256: format!("{:x}", Sha256::digest(&gen_rs_bytes)),
                },
                ManifestGeneratedFile {
                    byte_count: fixture_bytes.len() as u64,
                    filename: "crates/praana-core/tests/fixtures/unicode_v15_1.json".to_string(),
                    sha256: format!("{:x}", Sha256::digest(&fixture_bytes)),
                },
            ];
            let manifest_json = to_canonical_json(&manifest)? + "\n";
            fs::write(&manifest_path, manifest_json)?;

            println!("Unicode 15.1.0 generation complete.");
        }
        "verify" => {
            if !args[1..].contains(&"--offline".to_string()) {
                return Err("unicode verify requires --offline flag".into());
            }
            verify_sources(&source_dir, &manifest_path)?;

            // Regenerate into a temporary directory per Token Accounting §4.2
            let temp_dir =
                std::env::temp_dir().join(format!("praana_unicode_verify_{}", std::process::id()));
            fs::create_dir_all(&temp_dir)?;
            let (gen_rs_bytes, fixture_bytes) = generate_artifacts(&source_dir)?;
            let temp_gen_rs = temp_dir.join("generated_v15_1.rs");
            let temp_fixture = temp_dir.join("unicode_v15_1.json");
            fs::write(&temp_gen_rs, &gen_rs_bytes)?;
            fs::write(&temp_fixture, &fixture_bytes)?;

            let gen_rs_path = core_dir.join("src/unicode/generated_v15_1.rs");
            let fixture_path = core_dir.join("tests/fixtures/unicode_v15_1.json");

            let existing_gen_rs = fs::read(&gen_rs_path)
                .map_err(|e| format!("Missing generated file {}: {e}", gen_rs_path.display()))?;
            let existing_fixture = fs::read(&fixture_path)
                .map_err(|e| format!("Missing fixture file {}: {e}", fixture_path.display()))?;

            // Compare temp regenerated bytes to working tree
            if existing_gen_rs != gen_rs_bytes {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err("Generated Rust file does not match offline generator output".into());
            }
            if existing_fixture != fixture_bytes {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(
                    "Generated fixture file does not match offline generator output".into(),
                );
            }

            // Verify manifest.json generated_files hashes and byte counts
            let manifest_bytes = fs::read(&manifest_path)?;
            let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
            if manifest.generated_files.len() != 2 {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err("Manifest generated_files must have exactly 2 entries".into());
            }

            let gen_rs_sha = format!("{:x}", Sha256::digest(&gen_rs_bytes));
            let fixture_sha = format!("{:x}", Sha256::digest(&fixture_bytes));

            if manifest.generated_files[0].sha256 != gen_rs_sha
                || manifest.generated_files[0].byte_count != gen_rs_bytes.len() as u64
            {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(format!(
                    "Manifest generated_files[0] hash or size mismatch: manifest has {} bytes, hash {}; generated has {} bytes, hash {}",
                    manifest.generated_files[0].byte_count,
                    manifest.generated_files[0].sha256,
                    gen_rs_bytes.len(),
                    gen_rs_sha
                )
                .into());
            }

            if manifest.generated_files[1].sha256 != fixture_sha
                || manifest.generated_files[1].byte_count != fixture_bytes.len() as u64
            {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(format!(
                    "Manifest generated_files[1] hash or size mismatch: manifest has {} bytes, hash {}; generated has {} bytes, hash {}",
                    manifest.generated_files[1].byte_count,
                    manifest.generated_files[1].sha256,
                    fixture_bytes.len(),
                    fixture_sha
                )
                .into());
            }

            let _ = fs::remove_dir_all(&temp_dir);
            println!("unicode 15.1.0: sources=8 generated=2 verified");
        }
        other => {
            eprintln!("Unknown unicode command: {other}");
        }
    }

    Ok(())
}

fn write_canonical_value(val: &serde_json::Value, out: &mut Vec<u8>) {
    match val {
        serde_json::Value::Null => out.extend_from_slice(b"null"),
        serde_json::Value::Bool(true) => out.extend_from_slice(b"true"),
        serde_json::Value::Bool(false) => out.extend_from_slice(b"false"),
        serde_json::Value::Number(num) => out.extend_from_slice(num.to_string().as_bytes()),
        serde_json::Value::String(s) => {
            out.push(b'"');
            for b in s.bytes() {
                match b {
                    b'"' => out.extend_from_slice(b"\\\""),
                    b'\\' => out.extend_from_slice(b"\\\\"),
                    0x08 => out.extend_from_slice(b"\\b"),
                    0x09 => out.extend_from_slice(b"\\t"),
                    0x0A => out.extend_from_slice(b"\\n"),
                    0x0C => out.extend_from_slice(b"\\f"),
                    0x0D => out.extend_from_slice(b"\\r"),
                    b if b < 0x20 => {
                        let hex = format!("\\u{:04x}", b);
                        out.extend_from_slice(hex.as_bytes());
                    }
                    b => out.push(b),
                }
            }
            out.push(b'"');
        }
        serde_json::Value::Array(arr) => {
            out.push(b'[');
            for (i, elem) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical_value(elem, out);
            }
            out.push(b']');
        }
        serde_json::Value::Object(map) => {
            out.push(b'{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical_value(&serde_json::Value::String((*key).clone()), out);
                out.push(b':');
                write_canonical_value(&map[*key], out);
            }
            out.push(b'}');
        }
    }
}

fn to_canonical_json<T: serde::Serialize>(val: &T) -> Result<String, Box<dyn std::error::Error>> {
    let json_val = serde_json::to_value(val)?;
    let mut out = Vec::new();
    write_canonical_value(&json_val, &mut out);
    Ok(String::from_utf8(out)?)
}

fn verify_sources(
    source_dir: &Path,
    manifest_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let manifest_bytes = fs::read(manifest_path)
        .map_err(|e| format!("Cannot read manifest {}: {e}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;

    for src in &manifest.source_files {
        let file_path = source_dir.join(&src.filename);
        let bytes = fs::read(&file_path)
            .map_err(|e| format!("Cannot read source file {}: {e}", file_path.display()))?;
        if bytes.len() as u64 != src.byte_count {
            return Err(format!(
                "Source {} byte count mismatch: expected {}, got {}",
                src.filename,
                src.byte_count,
                bytes.len()
            )
            .into());
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if hash != src.sha256 {
            return Err(format!(
                "Source {} sha256 mismatch: expected {}, got {}",
                src.filename, src.sha256, hash
            )
            .into());
        }
    }
    Ok(())
}

fn parse_code_point_or_range(s: &str) -> (u32, u32) {
    let s = s.trim();
    if let Some((start, end)) = s.split_once("..") {
        let start_cp = u32::from_str_radix(start.trim(), 16).unwrap();
        let end_cp = u32::from_str_radix(end.trim(), 16).unwrap();
        (start_cp, end_cp)
    } else {
        let cp = u32::from_str_radix(s, 16).unwrap();
        (cp, cp)
    }
}

pub fn generate_artifacts(
    source_dir: &Path,
) -> Result<(Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
    // 1. Parse Scripts.txt for Han, Hiragana, Katakana, Hangul
    let scripts_content = fs::read_to_string(source_dir.join("Scripts.txt"))?;
    let mut cjk_ranges: Vec<(u32, u32)> = Vec::new();
    for line in scripts_content.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        if let Some((range_part, script_part)) = line.split_once(';') {
            let script = script_part.trim();
            if script == "Han" || script == "Hiragana" || script == "Katakana" || script == "Hangul"
            {
                let range = parse_code_point_or_range(range_part);
                cjk_ranges.push(range);
            }
        }
    }
    cjk_ranges = merge_ranges(cjk_ranges);

    // 2. Parse emoji-data.txt for Extended_Pictographic
    let emoji_content = fs::read_to_string(source_dir.join("emoji-data.txt"))?;
    let mut ext_pict_ranges: Vec<(u32, u32)> = Vec::new();
    for line in emoji_content.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        if let Some((range_part, prop_part)) = line.split_once(';') {
            let prop = prop_part.trim();
            if prop == "Extended_Pictographic" {
                let range = parse_code_point_or_range(range_part);
                ext_pict_ranges.push(range);
            }
        }
    }

    // 3. Parse UnicodeData.txt for General_Category starting with 'S' (Sm, Sc, Sk, So), CCC, and Canonical Decomposition
    let udata_content = fs::read_to_string(source_dir.join("UnicodeData.txt"))?;
    let mut symbol_ranges: Vec<(u32, u32)> = ext_pict_ranges;
    let mut ccc_map: BTreeMap<u32, u8> = BTreeMap::new();
    let mut decomp_map: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut comp_map: BTreeMap<(u32, u32), u32> = BTreeMap::new();

    let mut in_range_first: Option<(u32, String)> = None;

    for line in udata_content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(';').collect();
        if fields.len() < 15 {
            continue;
        }
        let cp = u32::from_str_radix(fields[0], 16)?;
        let name = fields[1];
        let cat = fields[2];
        let ccc = fields[3].parse::<u8>()?;
        let decomp = fields[5];

        if ccc > 0 {
            ccc_map.insert(cp, ccc);
        }

        if !decomp.is_empty() && !decomp.starts_with('<') {
            let mapped_cps: Result<Vec<u32>, _> = decomp
                .split_whitespace()
                .map(|s| u32::from_str_radix(s, 16))
                .collect();
            if let Ok(mcps) = mapped_cps {
                decomp_map.insert(cp, mcps.clone());
                if mcps.len() == 2 {
                    comp_map.insert((mcps[0], mcps[1]), cp);
                }
            }
        }

        if name.ends_with("First>") {
            in_range_first = Some((cp, cat.to_string()));
            continue;
        } else if name.ends_with("Last>") {
            if let Some((start_cp, start_cat)) = in_range_first.take() {
                if start_cat.starts_with('S') {
                    symbol_ranges.push((start_cp, cp));
                }
            }
            continue;
        }

        if cat.starts_with('S') {
            symbol_ranges.push((cp, cp));
        }
    }
    symbol_ranges = merge_ranges(symbol_ranges);

    // Filter Full_Composition_Exclusions from comp_map using DerivedNormalizationProps.txt
    let norm_props_content = fs::read_to_string(source_dir.join("DerivedNormalizationProps.txt"))?;
    let mut comp_exclusions: Vec<(u32, u32)> = Vec::new();
    let mut nfkc_cf_map: BTreeMap<u32, Vec<u32>> = BTreeMap::new();

    for line in norm_props_content.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(';').collect();
        if parts.len() >= 2 {
            let prop = parts[1].trim();
            if prop == "Full_Composition_Exclusion" || prop == "Comp_Ex" {
                let range = parse_code_point_or_range(parts[0]);
                comp_exclusions.push(range);
            } else if prop == "NFKC_CF" && parts.len() >= 3 {
                let range = parse_code_point_or_range(parts[0]);
                let mapping: Vec<u32> = parts[2]
                    .split_whitespace()
                    .filter_map(|s| u32::from_str_radix(s, 16).ok())
                    .collect();
                for c in range.0..=range.1 {
                    nfkc_cf_map.insert(c, mapping.clone());
                }
            }
        }
    }
    comp_exclusions = merge_ranges(comp_exclusions);

    comp_map.retain(|_, &mut target| !in_ranges(target, &comp_exclusions));

    // 4. Parse CaseFolding.txt for Default Case Folding (status C and F)
    let casefold_content = fs::read_to_string(source_dir.join("CaseFolding.txt"))?;
    let mut casefold_map: BTreeMap<u32, Vec<char>> = BTreeMap::new();
    for line in casefold_content.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(';').collect();
        if parts.len() >= 3 {
            let cp = u32::from_str_radix(parts[0].trim(), 16)?;
            let status = parts[1].trim();
            if status == "C" || status == "F" {
                let mapping: Vec<char> = parts[2]
                    .split_whitespace()
                    .filter_map(|s| u32::from_str_radix(s, 16).ok().and_then(char::from_u32))
                    .collect();
                casefold_map.insert(cp, mapping);
            }
        }
    }

    // Generate Rust source code
    let mut code = String::new();
    code.push_str("//! Auto-generated Unicode 15.1.0 tables. Do not edit manually.\n");
    code.push_str("//! Generated by praana-xtask unicode generate.\n\n");

    // UNICODE_CJK_RANGES
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const CJK_RANGES: &[(u32, u32)] = &[\n");
    for (start, end) in &cjk_ranges {
        code.push_str(&format!("    (0x{start:X}, 0x{end:X}),\n"));
    }
    code.push_str("];\n\n");

    // SYMBOL_OR_EMOJI_RANGES
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const SYMBOL_OR_EMOJI_RANGES: &[(u32, u32)] = &[\n");
    for (start, end) in &symbol_ranges {
        code.push_str(&format!("    (0x{start:X}, 0x{end:X}),\n"));
    }
    code.push_str("];\n\n");

    // CASEFOLD_TABLE: sorted (u32, &'static [char])
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const CASEFOLD_TABLE: &[(u32, &[char])] = &[\n");
    for (cp, chars) in &casefold_map {
        let chars_str: Vec<String> = chars
            .iter()
            .map(|c| format!("'\\u{{{:X}}}'", *c as u32))
            .collect();
        code.push_str(&format!("    (0x{cp:X}, &[{}]),\n", chars_str.join(", ")));
    }
    code.push_str("];\n\n");

    // NFKC_CF_TABLE: sorted (u32, &'static [char])
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const NFKC_CF_TABLE: &[(u32, &[char])] = &[\n");
    for (cp, chars_cps) in &nfkc_cf_map {
        let chars: Vec<char> = chars_cps
            .iter()
            .filter_map(|&c| char::from_u32(c))
            .collect();
        let chars_str: Vec<String> = chars
            .iter()
            .map(|c| format!("'\\u{{{:X}}}'", *c as u32))
            .collect();
        code.push_str(&format!("    (0x{cp:X}, &[{}]),\n", chars_str.join(", ")));
    }
    code.push_str("];\n\n");

    // CCC_TABLE: sorted (u32, u8)
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const CCC_TABLE: &[(u32, u8)] = &[\n");
    for (cp, ccc) in &ccc_map {
        code.push_str(&format!("    (0x{cp:X}, {ccc}),\n"));
    }
    code.push_str("];\n\n");

    // CANONICAL_DECOMP_TABLE: sorted (u32, &[char])
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const CANONICAL_DECOMP_TABLE: &[(u32, &[char])] = &[\n");
    for (cp, chars_cps) in &decomp_map {
        let chars: Vec<char> = chars_cps
            .iter()
            .filter_map(|&c| char::from_u32(c))
            .collect();
        let chars_str: Vec<String> = chars
            .iter()
            .map(|c| format!("'\\u{{{:X}}}'", *c as u32))
            .collect();
        code.push_str(&format!("    (0x{cp:X}, &[{}]),\n", chars_str.join(", ")));
    }
    code.push_str("];\n\n");

    // CANONICAL_COMP_TABLE: sorted ((u32, u32), char)
    code.push_str("#[rustfmt::skip]\n");
    code.push_str("pub const CANONICAL_COMP_TABLE: &[((u32, u32), char)] = &[\n");
    for ((first, second), target) in &comp_map {
        if let Some(target_char) = char::from_u32(*target) {
            code.push_str(&format!(
                "    ((0x{first:X}, 0x{second:X}), '\\u{{{:X}}}'),\n",
                target_char as u32
            ));
        }
    }
    code.push_str("];\n");

    // Fixture JSON
    let fixture_json = serde_json::json!({
        "unicode_version": UNICODE_VERSION,
        "utility_version": UTILITY_VERSION,
        "scalar_classification_samples": [
            {"input": "\u{200D}", "category": "ignored_format", "units": 0},
            {"input": "\u{FE00}", "category": "ignored_format", "units": 0},
            {"input": "\u{FE0F}", "category": "ignored_format", "units": 0},
            {"input": "\u{E0100}", "category": "ignored_format", "units": 0},
            {"input": "\u{E01EF}", "category": "ignored_format", "units": 0},
            {"input": "中", "category": "cjk_script", "units": 8},
            {"input": "文", "category": "cjk_script", "units": 8},
            {"input": "あ", "category": "cjk_script", "units": 8},
            {"input": "ア", "category": "cjk_script", "units": 8},
            {"input": "가", "category": "cjk_script", "units": 8},
            {"input": "😀", "category": "symbol_or_emoji", "units": 12},
            {"input": "❤", "category": "symbol_or_emoji", "units": 12},
            {"input": "$", "category": "symbol_or_emoji", "units": 12},
            {"input": "+", "category": "symbol_or_emoji", "units": 12},
            {"input": "^", "category": "symbol_or_emoji", "units": 12},
            {"input": "©", "category": "symbol_or_emoji", "units": 12},
            {"input": "a", "category": "other_scalar", "units": 3},
            {"input": "Z", "category": "other_scalar", "units": 3},
            {"input": "9", "category": "other_scalar", "units": 3},
            {"input": " ", "category": "other_scalar", "units": 3},
            {"input": "\n", "category": "other_scalar", "units": 3},
            {"input": "\r", "category": "other_scalar", "units": 3},
            {"input": "\u{0301}", "category": "other_scalar", "units": 3}
        ],
        "default_casefold_samples": [
            {"input": "Straße", "output": "strasse"},
            {"input": "\u{03A3}\u{03C2}\u{03C3}", "output": "\u{03C3}\u{03C3}\u{03C3}"},
            {"input": "\u{0130}I\u{0131}", "output": "i\u{0307}i\u{0131}"},
            {"input": "HELLO world 123!", "output": "hello world 123!"}
        ],
        "nfkc_casefold_samples": [
            {"input": "\u{212A}", "output": "k"},
            {"input": "\u{FB03}", "output": "ffi"},
            {"input": "\u{FF21}/\u{FF22}", "output": "a/b"},
            {"input": "Straße", "output": "strasse"}
        ]
    });

    let fixture_bytes = (serde_json::to_string_pretty(&fixture_json)? + "\n").into_bytes();

    Ok((code.into_bytes(), fixture_bytes))
}

fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .binary_search_by(|&(start, end)| {
            if cp < start {
                std::cmp::Ordering::Greater
            } else if cp > end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn merge_ranges(mut ranges: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    if ranges.is_empty() {
        return ranges;
    }
    ranges.sort_unstable_by_key(|r| r.0);
    let mut merged = Vec::with_capacity(ranges.len());
    let mut current = ranges[0];
    for &next in &ranges[1..] {
        if next.0 <= current.1 + 1 {
            current.1 = current.1.max(next.1);
        } else {
            merged.push(current);
            current = next;
        }
    }
    merged.push(current);
    merged
}
