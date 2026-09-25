//! Streaming redaction must match complete-input redaction at every split.

use praana_core::redaction::{redact_text_v1, StreamingRedactor};

fn aws() -> String {
    "AKIA".to_owned() + &"B".repeat(16)
}

fn samples() -> Vec<String> {
    vec![
        format!("prefix {} suffix", aws()),
        format!("sk-ant-{}", "c".repeat(20)),
        format!("export PASSWORD={}\nkeep", "secretvalue"),
        "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----".into(),
        "-----BEGIN RSA PRIVATE KEY-----\nabcd".into(),
        format!("a {}\nb {}", aws(), "ghp_".to_owned() + &"d".repeat(36)),
    ]
}

fn stream_all(input: &str, split_at: usize) -> (String, praana_core::redaction::RedactedText) {
    let bytes = input.as_bytes();
    let mut redactor = StreamingRedactor::new();
    let mut out = String::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let end = (offset + split_at).min(bytes.len());
        out.push_str(&redactor.push(&bytes[offset..end]).unwrap());
        offset = end;
    }
    let done = redactor.finish().unwrap();
    out.push_str(&done.tail);
    (out, done)
}

#[test]
fn every_byte_split_matches_complete_redaction() {
    for sample in samples() {
        let complete = redact_text_v1(&sample).unwrap();
        for split in 1..=sample.len() {
            let (streamed, done) = stream_all(&sample, split);
            assert_eq!(streamed, complete.text, "split {split}");
            assert_eq!(done.summary, complete.summary, "split {split}");
            assert_eq!(done.warnings, complete.warnings, "split {split}");
        }
    }
}

#[test]
fn one_byte_chunks_hide_a_secret_split_across_boundaries() {
    let sample = format!("xx {} yy", aws());
    let (streamed, _) = stream_all(&sample, 1);
    assert!(!streamed.contains(&aws()));
    assert!(streamed.contains("[REDACTED:aws-access-key]"));
}

#[test]
fn invalid_utf8_fails_closed_without_emitting_the_bytes() {
    let mut redactor = StreamingRedactor::new();
    let err = redactor.push(&[0xff, 0xfe]).unwrap_err();
    assert!(!err.to_string().contains('\u{fffd}'));
    let finished = redactor.finish();
    assert!(finished.is_err());
}

#[test]
fn long_line_does_not_retain_the_whole_input() {
    let mut redactor = StreamingRedactor::new();
    let line = "a".repeat(200_000);
    redactor.push(line.as_bytes()).unwrap();
    assert!(redactor.retained_len() <= 65_536 + 512 + 8);
}

#[test]
fn over_limit_line_matches_complete_redaction() {
    let line = format!("API_KEY={}\n", "v".repeat(70_000));
    let complete = redact_text_v1(&line).unwrap();
    let (streamed, done) = stream_all(&line, 4096);
    assert_eq!(streamed, complete.text);
    assert_eq!(done.summary, complete.summary);
    assert!(!streamed.contains(&"v".repeat(32)));
}
