//! Versioned Unicode 15.1 utilities.
//!
//! Normative owner: `docs/RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.

pub mod generated_v15_1;

use generated_v15_1::{
    CANONICAL_COMP_TABLE, CANONICAL_DECOMP_TABLE, CASEFOLD_TABLE, CCC_TABLE, CJK_RANGES,
    NFKC_CF_TABLE, SYMBOL_OR_EMOJI_RANGES,
};
use serde::{Deserialize, Serialize};

pub const UNICODE_VERSION: &str = "15.1.0";
pub const UNICODE_UTILITY_VERSION: &str = "praana-unicode-15.1-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnicodeScalarCategory {
    IgnoredFormat,
    CjkScript,
    SymbolOrEmoji,
    OtherScalar,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnicodeUtilityInfo {
    pub utility_version: String,
    pub unicode_version: String,
}

impl UnicodeUtilityInfo {
    pub fn current() -> Self {
        Self {
            utility_version: UNICODE_UTILITY_VERSION.to_string(),
            unicode_version: UNICODE_VERSION.to_string(),
        }
    }
}

/// Classify scalar and return units in 12ths of a token (0, 8, 12, or 3) and its category.
pub fn scalar_token_units_v15_1(c: char) -> (u32, UnicodeScalarCategory) {
    let cp = c as u32;

    // 1. Ignored format: U+200D, U+FE00..=U+FE0F, U+E0100..=U+E01EF -> 0 units
    if cp == 0x200D || (0xFE00..=0xFE0F).contains(&cp) || (0xE0100..=0xE01EF).contains(&cp) {
        return (0, UnicodeScalarCategory::IgnoredFormat);
    }

    // 2. CJK script (Han, Hiragana, Katakana, Hangul) -> 8 units
    if in_ranges(cp, CJK_RANGES) {
        return (8, UnicodeScalarCategory::CjkScript);
    }

    // 3. Symbol or Emoji: Extended_Pictographic or General_Category in Sm, Sc, Sk, So -> 12 units
    if in_ranges(cp, SYMBOL_OR_EMOJI_RANGES) {
        return (12, UnicodeScalarCategory::SymbolOrEmoji);
    }

    // 4. Other scalar -> 3 units
    (3, UnicodeScalarCategory::OtherScalar)
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

/// Unicode Default Case Folding from CaseFolding.txt (status C and F).
pub fn default_casefold_v1(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let cp = c as u32;
        if let Ok(idx) = CASEFOLD_TABLE.binary_search_by_key(&cp, |&(entry_cp, _)| entry_cp) {
            for &fc in CASEFOLD_TABLE[idx].1 {
                out.push(fc);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Unicode Default Case Folding with byte offsets mapping each byte in the folded string
/// back to the source scalar's byte range `(start, end)` in `s`.
pub fn default_casefold_v1_with_offsets(s: &str) -> (String, Vec<(usize, usize)>) {
    let mut out_str = String::with_capacity(s.len());
    let mut out_offsets = Vec::with_capacity(s.len());

    for (byte_idx, c) in s.char_indices() {
        let src_range = (byte_idx, byte_idx + c.len_utf8());
        let cp = c as u32;
        if let Ok(idx) = CASEFOLD_TABLE.binary_search_by_key(&cp, |&(entry_cp, _)| entry_cp) {
            for &fc in CASEFOLD_TABLE[idx].1 {
                let start_len = out_str.len();
                out_str.push(fc);
                let added_bytes = out_str.len() - start_len;
                for _ in 0..added_bytes {
                    out_offsets.push(src_range);
                }
            }
        } else {
            let start_len = out_str.len();
            out_str.push(c);
            let added_bytes = out_str.len() - start_len;
            for _ in 0..added_bytes {
                out_offsets.push(src_range);
            }
        }
    }

    (out_str, out_offsets)
}

const S_BASE: u32 = 0xAC00;
const L_BASE: u32 = 0x1100;
const V_BASE: u32 = 0x1161;
const T_BASE: u32 = 0x11A7;
const L_COUNT: u32 = 19;
const V_COUNT: u32 = 21;
const T_COUNT: u32 = 28;
const N_COUNT: u32 = V_COUNT * T_COUNT; // 588
const S_COUNT: u32 = L_COUNT * N_COUNT; // 11172

fn get_ccc(cp: u32) -> u8 {
    if let Ok(idx) = CCC_TABLE.binary_search_by_key(&cp, |&(entry_cp, _)| entry_cp) {
        CCC_TABLE[idx].1
    } else {
        0
    }
}

fn decompose_nfkc_cf_recursive(cp: u32, out: &mut Vec<char>) {
    // Hangul syllable decomposition
    if (S_BASE..S_BASE + S_COUNT).contains(&cp) {
        let s_index = cp - S_BASE;
        let l = L_BASE + s_index / N_COUNT;
        let v = V_BASE + (s_index % N_COUNT) / T_COUNT;
        let t = T_BASE + s_index % T_COUNT;
        out.push(char::from_u32(l).unwrap());
        out.push(char::from_u32(v).unwrap());
        if t != T_BASE {
            out.push(char::from_u32(t).unwrap());
        }
        return;
    }

    // NFKC_CF table
    if let Ok(idx) = NFKC_CF_TABLE.binary_search_by_key(&cp, |&(entry_cp, _)| entry_cp) {
        for &m in NFKC_CF_TABLE[idx].1 {
            decompose_nfkc_cf_recursive(m as u32, out);
        }
        return;
    }

    // Canonical decomposition table
    if let Ok(idx) = CANONICAL_DECOMP_TABLE.binary_search_by_key(&cp, |&(entry_cp, _)| entry_cp) {
        for &m in CANONICAL_DECOMP_TABLE[idx].1 {
            decompose_nfkc_cf_recursive(m as u32, out);
        }
        return;
    }

    if let Some(c) = char::from_u32(cp) {
        out.push(c);
    }
}

/// Unicode 15.1 NFKC_Casefold mapping followed by canonical composition (NFC).
pub fn nfkc_casefold_v1(s: &str) -> String {
    // 1. Recursive decomposition with NFKC_CF & Canonical Decomposition
    let mut decomposed = Vec::with_capacity(s.len() * 2);
    for c in s.chars() {
        decompose_nfkc_cf_recursive(c as u32, &mut decomposed);
    }

    // 2. Canonical Ordering Algorithm (sort non-zero CCC sequences)
    let mut i = 0;
    while i < decomposed.len() {
        let ccc = get_ccc(decomposed[i] as u32);
        if ccc > 0 {
            let mut j = i + 1;
            while j < decomposed.len() && get_ccc(decomposed[j] as u32) > 0 {
                j += 1;
            }
            // Stable sort slice by CCC
            decomposed[i..j].sort_by_key(|&c| get_ccc(c as u32));
            i = j;
        } else {
            i += 1;
        }
    }

    // 3. Canonical Composition (NFC)
    if decomposed.is_empty() {
        return String::new();
    }

    let mut composed: Vec<char> = Vec::with_capacity(decomposed.len());
    let mut starter_idx = 0;
    composed.push(decomposed[0]);

    for &current in &decomposed[1..] {
        let current_ccc = get_ccc(current as u32);

        let starter = composed[starter_idx];

        // Try Hangul L + V -> LV or LV + T -> LVT
        let starter_cp = starter as u32;
        let current_cp = current as u32;

        let mut combined = false;

        // Check Hangul L + V
        if (0x1100..=0x1112).contains(&starter_cp) && (0x1161..=0x1175).contains(&current_cp) {
            let l_index = starter_cp - L_BASE;
            let v_index = current_cp - V_BASE;
            let lv_index = (l_index * V_COUNT + v_index) * T_COUNT;
            let lv_cp = S_BASE + lv_index;
            if let Some(lv_char) = char::from_u32(lv_cp) {
                composed[starter_idx] = lv_char;
                combined = true;
            }
        } else if (S_BASE..=(S_BASE + S_COUNT - 1)).contains(&starter_cp)
            && (starter_cp - S_BASE).is_multiple_of(T_COUNT)
            && (0x11A8..=0x11C2).contains(&current_cp)
        {
            // Hangul LV + T
            let t_index = current_cp - T_BASE;
            let lvt_cp = starter_cp + t_index;
            if let Some(lvt_char) = char::from_u32(lvt_cp) {
                composed[starter_idx] = lvt_char;
                combined = true;
            }
        } else {
            // Check CANONICAL_COMP_TABLE
            // Rule: No character with CCC >= current_ccc or CCC == 0 can intervene.
            let mut blocked = false;
            let mut prev_ccc = 0;
            for intervening in &composed[starter_idx + 1..] {
                let iccc = get_ccc(*intervening as u32);
                if iccc >= current_ccc || iccc == 0 {
                    blocked = true;
                    break;
                }
                prev_ccc = iccc;
            }

            if !blocked && (current_ccc > prev_ccc || starter_idx + 1 == composed.len()) {
                if let Ok(c_idx) = CANONICAL_COMP_TABLE
                    .binary_search_by_key(&(starter_cp, current_cp), |&(pair, _)| pair)
                {
                    let comp_char = CANONICAL_COMP_TABLE[c_idx].1;
                    composed[starter_idx] = comp_char;
                    combined = true;
                }
            }
        }

        if !combined {
            if current_ccc == 0 {
                starter_idx = composed.len();
            }
            composed.push(current);
        }
    }

    composed.into_iter().collect()
}
