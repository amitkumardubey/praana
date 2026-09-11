use praana_core::unicode::{
    default_casefold_v1, default_casefold_v1_with_offsets, nfkc_casefold_v1,
    scalar_token_units_v15_1, UnicodeScalarCategory, UnicodeUtilityInfo, UNICODE_UTILITY_VERSION,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

#[test]
fn unicode_utility_version_is_pinned() {
    let info = UnicodeUtilityInfo::current();
    assert_eq!(info.utility_version, "praana-unicode-15.1-v1");
    assert_eq!(info.unicode_version, "15.1.0");
    assert_eq!(UNICODE_UTILITY_VERSION, "praana-unicode-15.1-v1");
}

#[test]
fn scalar_weights_and_categories_match_spec() {
    // Ignored format: U+200D, U+FE00..U+FE0F, U+E0100..U+E01EF -> 0 units
    assert_eq!(
        scalar_token_units_v15_1('\u{200D}'),
        (0, UnicodeScalarCategory::IgnoredFormat)
    );
    assert_eq!(
        scalar_token_units_v15_1('\u{FE00}'),
        (0, UnicodeScalarCategory::IgnoredFormat)
    );
    assert_eq!(
        scalar_token_units_v15_1('\u{FE0F}'),
        (0, UnicodeScalarCategory::IgnoredFormat)
    );
    assert_eq!(
        scalar_token_units_v15_1('\u{E0100}'),
        (0, UnicodeScalarCategory::IgnoredFormat)
    );
    assert_eq!(
        scalar_token_units_v15_1('\u{E01EF}'),
        (0, UnicodeScalarCategory::IgnoredFormat)
    );

    // CJK script (Han, Hiragana, Katakana, Hangul) -> 8 units
    assert_eq!(
        scalar_token_units_v15_1('\u{4E2D}'),
        (8, UnicodeScalarCategory::CjkScript)
    ); // 中 (Han)
    assert_eq!(
        scalar_token_units_v15_1('\u{6587}'),
        (8, UnicodeScalarCategory::CjkScript)
    ); // 文 (Han)
    assert_eq!(
        scalar_token_units_v15_1('\u{3042}'),
        (8, UnicodeScalarCategory::CjkScript)
    ); // あ (Hiragana)
    assert_eq!(
        scalar_token_units_v15_1('\u{30A2}'),
        (8, UnicodeScalarCategory::CjkScript)
    ); // ア (Katakana)
    assert_eq!(
        scalar_token_units_v15_1('\u{AC00}'),
        (8, UnicodeScalarCategory::CjkScript)
    ); // 가 (Hangul)

    // Symbol/Emoji: Extended_Pictographic or General_Category in Sm, Sc, Sk, So -> 12 units
    assert_eq!(
        scalar_token_units_v15_1('\u{1F600}'),
        (12, UnicodeScalarCategory::SymbolOrEmoji)
    ); // 😀
    assert_eq!(
        scalar_token_units_v15_1('\u{2764}'),
        (12, UnicodeScalarCategory::SymbolOrEmoji)
    ); // ❤
    assert_eq!(
        scalar_token_units_v15_1('$'),
        (12, UnicodeScalarCategory::SymbolOrEmoji)
    ); // Sc
    assert_eq!(
        scalar_token_units_v15_1('+'),
        (12, UnicodeScalarCategory::SymbolOrEmoji)
    ); // Sm
    assert_eq!(
        scalar_token_units_v15_1('^'),
        (12, UnicodeScalarCategory::SymbolOrEmoji)
    ); // Sk
    assert_eq!(
        scalar_token_units_v15_1('©'),
        (12, UnicodeScalarCategory::SymbolOrEmoji)
    ); // So

    // Other scalars -> 3 units
    assert_eq!(
        scalar_token_units_v15_1('a'),
        (3, UnicodeScalarCategory::OtherScalar)
    );
    assert_eq!(
        scalar_token_units_v15_1('Z'),
        (3, UnicodeScalarCategory::OtherScalar)
    );
    assert_eq!(
        scalar_token_units_v15_1('9'),
        (3, UnicodeScalarCategory::OtherScalar)
    );
    assert_eq!(
        scalar_token_units_v15_1(' '),
        (3, UnicodeScalarCategory::OtherScalar)
    );
    assert_eq!(
        scalar_token_units_v15_1('\n'),
        (3, UnicodeScalarCategory::OtherScalar)
    );
    assert_eq!(
        scalar_token_units_v15_1('\r'),
        (3, UnicodeScalarCategory::OtherScalar)
    );
    assert_eq!(
        scalar_token_units_v15_1('\u{0301}'),
        (3, UnicodeScalarCategory::OtherScalar)
    ); // Combining acute accent
}

#[test]
fn default_casefold_v1_fixtures() {
    assert_eq!(default_casefold_v1("Straße"), "strasse");
    assert_eq!(
        default_casefold_v1("\u{03A3}\u{03C2}\u{03C3}"),
        "\u{03C3}\u{03C3}\u{03C3}"
    ); // Σςσ -> σσσ
    assert_eq!(
        default_casefold_v1("\u{0130}I\u{0131}"),
        "i\u{0307}i\u{0131}"
    ); // İIı -> i\u0307iı (non-Turkic default: İ -> i + combining dot above)
    assert_eq!(default_casefold_v1("HELLO world 123!"), "hello world 123!");
}

#[test]
fn default_casefold_v1_with_offsets_mapping() {
    let original = "Straße";
    let (folded, offsets) = default_casefold_v1_with_offsets(original);
    assert_eq!(folded, "strasse");
    assert_eq!(offsets.len(), folded.len());
    // In "Straße": 'S'(1) 't'(1) 'r'(1) 'a'(1) 'ß'(2) 'e'(1) = 7 bytes
    // In folded "strasse": "ss" maps to original 'ß' byte range 4..6
    assert_eq!(&original[offsets[4].0..offsets[4].1], "ß");
    assert_eq!(&original[offsets[5].0..offsets[5].1], "ß");
}

#[test]
fn casefold_match_expansion_boundaries() {
    // Test that match starting or ending inside a multi-scalar expansion reports the full original range
    let original = "pre-Straße-post";
    let (folded, offsets) = default_casefold_v1_with_offsets(original);
    assert_eq!(folded, "pre-strasse-post");

    // Substring "as" matches inside "strasse" at indices 6..8 ("as")
    // 'a' is at index 6 (orig byte 7..8)
    // 's' is at index 7 (orig byte 8..10 for 'ß')
    let match_start = folded.find("as").unwrap();
    let match_len = "as".len();
    let start_orig = offsets[match_start].0;
    let end_orig = offsets[match_start + match_len - 1].1;
    // The original byte range expanded to cover 'ß' completely
    assert_eq!(&original[start_orig..end_orig], "aß");
}

#[test]
fn nfkc_casefold_v1_fixtures() {
    assert_eq!(nfkc_casefold_v1("\u{212A}"), "k"); // Kelvin sign K -> k
    assert_eq!(nfkc_casefold_v1("\u{FB03}"), "ffi"); // Ligature ﬃ -> ffi
    assert_eq!(nfkc_casefold_v1("\u{FF21}/\u{FF22}"), "a/b"); // Fullwidth Ａ/Ｂ -> a/b
    assert_eq!(nfkc_casefold_v1("Straße"), "strasse");
}

#[test]
fn unicode_manifest_provenance_verification() {
    let manifest_path = PathBuf::from("data/unicode/15.1.0/manifest.json");
    let manifest_bytes = fs::read(&manifest_path)
        .or_else(|_| {
            fs::read(PathBuf::from(
                "crates/praana-core/data/unicode/15.1.0/manifest.json",
            ))
        })
        .expect("manifest.json must be present");

    let manifest_json: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).expect("valid manifest json");

    assert_eq!(manifest_json["unicode_version"], "15.1.0");
    assert_eq!(manifest_json["utility_version"], "praana-unicode-15.1-v1");

    let gen_files = manifest_json["generated_files"].as_array().unwrap();
    assert_eq!(gen_files.len(), 2);

    // Verify generated_v15_1.rs
    let gen_rs_path = PathBuf::from("src/unicode/generated_v15_1.rs");
    let gen_rs_bytes = fs::read(&gen_rs_path)
        .or_else(|_| {
            fs::read(PathBuf::from(
                "crates/praana-core/src/unicode/generated_v15_1.rs",
            ))
        })
        .expect("generated_v15_1.rs must exist");

    let gen_rs_sha = format!("{:x}", Sha256::digest(&gen_rs_bytes));
    assert_eq!(gen_files[0]["sha256"], gen_rs_sha);
    assert_eq!(gen_files[0]["byte_count"], gen_rs_bytes.len() as u64);

    // Verify tests/fixtures/unicode_v15_1.json
    let fixture_path = PathBuf::from("tests/fixtures/unicode_v15_1.json");
    let fixture_bytes = fs::read(&fixture_path)
        .or_else(|_| {
            fs::read(PathBuf::from(
                "crates/praana-core/tests/fixtures/unicode_v15_1.json",
            ))
        })
        .expect("unicode_v15_1.json must exist");

    let fixture_sha = format!("{:x}", Sha256::digest(&fixture_bytes));
    assert_eq!(gen_files[1]["sha256"], fixture_sha);
    assert_eq!(gen_files[1]["byte_count"], fixture_bytes.len() as u64);
}

#[test]
fn unicode_fixtures_json_verification() {
    let fixture_path = PathBuf::from("tests/fixtures/unicode_v15_1.json");
    let fixture_bytes = fs::read(&fixture_path)
        .or_else(|_| {
            fs::read(PathBuf::from(
                "crates/praana-core/tests/fixtures/unicode_v15_1.json",
            ))
        })
        .expect("unicode_v15_1.json must exist");

    let fixture_val: serde_json::Value =
        serde_json::from_slice(&fixture_bytes).expect("valid fixture json");

    // Test casefold samples
    for sample in fixture_val["default_casefold_samples"].as_array().unwrap() {
        let input = sample["input"].as_str().unwrap();
        let expected = sample["output"].as_str().unwrap();
        assert_eq!(default_casefold_v1(input), expected);
    }

    // Test nfkc samples
    for sample in fixture_val["nfkc_casefold_samples"].as_array().unwrap() {
        let input = sample["input"].as_str().unwrap();
        let expected = sample["output"].as_str().unwrap();
        assert_eq!(nfkc_casefold_v1(input), expected);
    }

    // Test scalar classification samples
    for sample in fixture_val["scalar_classification_samples"]
        .as_array()
        .unwrap()
    {
        let input_str = sample["input"].as_str().unwrap();
        let expected_units = sample["units"].as_u64().unwrap();
        let expected_category = sample["category"].as_str().unwrap();

        let ch = input_str.chars().next().unwrap();
        let (units, cat) = scalar_token_units_v15_1(ch);
        assert_eq!(units as u64, expected_units);
        match cat {
            UnicodeScalarCategory::IgnoredFormat => assert_eq!(expected_category, "ignored_format"),
            UnicodeScalarCategory::CjkScript => assert_eq!(expected_category, "cjk_script"),
            UnicodeScalarCategory::SymbolOrEmoji => {
                assert_eq!(expected_category, "symbol_or_emoji")
            }
            UnicodeScalarCategory::OtherScalar => assert_eq!(expected_category, "other_scalar"),
        }
    }
}
