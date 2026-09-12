//! RFC 8785 JSON Canonicalization Scheme (JCS) implementation.
//!
//! Normative reference: RFC 8785 (https://www.rfc-editor.org/rfc/rfc8785).

use serde::Serialize;
use serde_json::Value;

/// Serialize any serializable value into RFC 8785 canonical JSON bytes.
pub fn to_canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    to_canonical_json_bytes_with(value, false)
}

/// RFC 8785 canonical JSON with Compaction §10 `safe_json` string escaping.
///
/// Literal `<`, `>`, and `&` inside JSON strings are emitted as `\u003c`,
/// `\u003e`, and `\u0026` while encoding, not by editing a finished byte stream.
pub fn to_canonical_json_bytes_html_safe<T: Serialize>(
    value: &T,
) -> Result<Vec<u8>, serde_json::Error> {
    to_canonical_json_bytes_with(value, true)
}

fn to_canonical_json_bytes_with<T: Serialize>(
    value: &T,
    html_safe: bool,
) -> Result<Vec<u8>, serde_json::Error> {
    let json_val = serde_json::to_value(value)?;
    let mut out = Vec::new();
    write_canonical_value(&json_val, &mut out, html_safe);
    Ok(out)
}

/// Serialize any serializable value into an RFC 8785 canonical JSON string.
pub fn to_canonical_json_string<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    let bytes = to_canonical_json_bytes(value)?;
    Ok(String::from_utf8(bytes).expect("canonical json is guaranteed valid utf-8"))
}

fn write_canonical_value(val: &Value, out: &mut Vec<u8>, html_safe: bool) {
    match val {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(num) => write_canonical_number(num, out),
        Value::String(s) => write_canonical_string(s, out, html_safe),
        Value::Array(arr) => {
            out.push(b'[');
            for (i, elem) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical_value(elem, out, html_safe);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            out.push(b'{');
            // RFC 8785 Section 3.2.3:
            // "The keys of every JSON object MUST be sorted in lexicographical order by the UTF-16 code units of their names."
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| {
                let a_units = a.encode_utf16();
                let b_units = b.encode_utf16();
                a_units.cmp(b_units)
            });

            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical_string(key, out, html_safe);
                out.push(b':');
                write_canonical_value(&map[*key], out, html_safe);
            }
            out.push(b'}');
        }
    }
}

fn write_canonical_string(s: &str, out: &mut Vec<u8>, html_safe: bool) {
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
            b'<' if html_safe => out.extend_from_slice(br"\u003c"),
            b'>' if html_safe => out.extend_from_slice(br"\u003e"),
            b'&' if html_safe => out.extend_from_slice(br"\u0026"),
            b if b < 0x20 => {
                let hex = format!("\\u{:04x}", b);
                out.extend_from_slice(hex.as_bytes());
            }
            b => out.push(b),
        }
    }
    out.push(b'"');
}

fn write_canonical_number(num: &serde_json::Number, out: &mut Vec<u8>) {
    if let Some(i) = num.as_i64() {
        out.extend_from_slice(i.to_string().as_bytes());
    } else if let Some(u) = num.as_u64() {
        out.extend_from_slice(u.to_string().as_bytes());
    } else if let Some(f) = num.as_f64() {
        // RFC 8785 Section 3.2.2.3:
        // Follow ECMAScript Canonical Number representation.
        if f.is_nan() || f.is_infinite() {
            out.extend_from_slice(b"null");
        } else if f == 0.0 {
            out.extend_from_slice(b"0");
        } else if f.fract() == 0.0 && f.abs() < 1e21 {
            // Integer float
            let formatted = format!("{:.0}", f);
            out.extend_from_slice(formatted.as_bytes());
        } else {
            // Shortest representation without trailing decimal zeros
            let formatted = num.to_string();
            out.extend_from_slice(formatted.as_bytes());
        }
    } else {
        out.extend_from_slice(num.to_string().as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rfc8785_object_key_sorting() {
        let val = json!({
            "zebra": 1,
            "apple": 2,
            "banana": {"c": 3, "a": 4}
        });
        let canonical = to_canonical_json_string(&val).unwrap();
        assert_eq!(canonical, r#"{"apple":2,"banana":{"a":4,"c":3},"zebra":1}"#);
    }

    #[test]
    fn rfc8785_escaping_and_no_whitespace() {
        let val = json!({
            "msg": "hello\nworld\t\"escaped\"",
            "url": "https://example.com/api"
        });
        let canonical = to_canonical_json_string(&val).unwrap();
        // Notice "/" must not be escaped in RFC 8785
        assert_eq!(
            canonical,
            r#"{"msg":"hello\nworld\t\"escaped\"","url":"https://example.com/api"}"#
        );
    }

    #[test]
    fn rfc8785_numbers() {
        let val = json!({
            "zero": 0,
            "negative_zero": -0.0,
            "int": 42,
            "ratio": 0.6,
            "ratio_two": 0.45
        });
        let canonical = to_canonical_json_string(&val).unwrap();
        assert_eq!(
            canonical,
            r#"{"int":42,"negative_zero":0,"ratio":0.6,"ratio_two":0.45,"zero":0}"#
        );
    }
}
