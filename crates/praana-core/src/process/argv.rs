//! Windows command-line quoting for direct `CreateProcessW` argv.
//!
//! The rules match `CommandLineToArgvW`: metacharacters stay inside one
//! argument because the platform shell is not asked to parse them.

pub fn quote_windows_command(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| quote_windows_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn quote_windows_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_owned();
    }
    let needs_quotes = arg.chars().any(|ch| {
        ch.is_whitespace()
            || matches!(
                ch,
                '"' | '&' | '|' | '<' | '>' | '^' | '%' | '!' | '(' | ')'
            )
    });
    if !needs_quotes {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(backslashes * 2 + 1));
            out.push('"');
            backslashes = 0;
            continue;
        }
        if backslashes > 0 {
            out.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
        }
        out.push(ch);
    }
    if backslashes > 0 {
        out.push_str(&"\\".repeat(backslashes * 2));
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_metacharacters_and_non_ascii_as_one_argument() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg("a&b|c"), "\"a&b|c\"");
        assert_eq!(quote_windows_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(quote_windows_arg("café file"), "\"café file\"");
        assert_eq!(quote_windows_arg("trail\\"), "trail\\");
        assert_eq!(quote_windows_arg("a b\\"), "\"a b\\\\\"");
        let command = quote_windows_command(&["git".into(), "status".into(), "my file.txt".into()]);
        assert_eq!(command, "git status \"my file.txt\"");
        assert!(!command.contains("cmd"));
    }
}
