/** Withhold syntax whose meaning cannot be known until more input arrives. */
export function withholdIncompleteSyntax(text: string): string {
  const open: { marker: string; at: number }[] = [];
  let inlineCode: { marker: string; at: number } | undefined;
  let fence: { marker: string; length: number } | undefined;
  let tableStart = -1;
  let tableReady = false;
  let tableHasRule = false;
  let tableColumns = 0;
  let offset = 0;
  let cutoff = text.length;
  const lastLineOffset = text.trimEnd().lastIndexOf("\n") + 1;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const lastLine = offset >= lastLineOffset;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && (!line.trim() || fenceMatch || /^ {0,3}(?:#{1,6}(?:\s|$)|[-+*]\s|\d{1,9}[.)]\s|>|\|)/.test(line))) {
      open.length = 0;
      inlineCode = undefined;
    }
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && !fenceMatch[2]!.trim()) fence = undefined;
      offset += line.length + 1;
      continue;
    }
    if (fence) {
      offset += line.length + 1;
      continue;
    }

    // A header-only table falls back to raw text in OpenTUI 0.8. Hold the
    // whole candidate until a matching separator AND first data row exist.
    const tableLine = /^\s*\|/.test(line);
    const columns = tableLine ? line.trim().slice(1).replace(/\|$/, "").split(/(?<!\\)\|/).length : 0;
    const tableHeader = tableLine && tableStart < 0;
    if (tableHeader) {
      tableStart = offset;
      tableColumns = columns;
    } else if (!tableLine && line.trim()) {
      tableStart = -1;
      tableReady = false;
      tableHasRule = false;
    }

    // A lone marker can acquire text with the very next delta, even though
    // CommonMark's flanking rules do not yet consider it an opening span.
    if (lastLine && /^\s*(?:#{1,6}|\*+|_+|`+)\s*$/.test(line)) {
      const marker = line.trim();
      if (!open.some((span) => span.marker[0] === marker[0]) && inlineCode?.marker !== marker) {
        cutoff = Math.min(cutoff, offset);
      }
    }

    for (let column = 0; column < line.length;) {
      const at = offset + column;
      const char = line[column]!;
      if (char === "\\" && !inlineCode) {
        column += 2;
        continue;
      }
      if (!"*_`".includes(char)) {
        column++;
        continue;
      }
      let end = column + 1;
      while (line[end] === char) end++;
      const marker = line.slice(column, end);
      if (char === "`") {
        if (inlineCode?.marker === marker) inlineCode = undefined;
        else if (!inlineCode) inlineCode = { marker, at };
      } else if (!inlineCode) {
        const before = column === 0 ? "\n" : line[column - 1]!;
        const after = end === line.length ? "\n" : line[end]!;
        const beforeSpace = /\s/.test(before);
        const afterSpace = /\s/.test(after);
        const beforePunct = /[\p{P}\p{S}]/u.test(before);
        const afterPunct = /[\p{P}\p{S}]/u.test(after);
        const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
        const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
        const canClose = right && (char !== "_" || !left || afterPunct);
        const canOpen = left && (char !== "_" || !right || beforePunct);
        let remaining = marker.length;
        if (canClose) {
          while (remaining > 0 && open.at(-1)?.marker[0] === char) {
            const span = open.at(-1)!;
            const consumed = Math.min(remaining, span.marker.length);
            remaining -= consumed;
            if (consumed === span.marker.length) open.pop();
            else span.marker = span.marker.slice(consumed);
          }
        }
        if (remaining > 0 && (canOpen || (end === line.length && (beforeSpace || beforePunct)))) {
          open.push({ marker: char.repeat(remaining), at: at + marker.length - remaining });
        }
      }
      column = end;
    }
    if (tableLine) {
      const complete = columns === tableColumns && /\|\s*$/.test(line) && open.length === 0 && !inlineCode;
      if (!tableHeader && complete) {
        if (/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) tableHasRule = true;
        else if (tableHasRule) tableReady = true;
      }
      if (lastLine && (!tableReady || !complete)) {
        cutoff = Math.min(cutoff, tableReady ? offset : tableStart);
      }
    }
    offset += line.length + 1;
  }
  const pending = [open[0]?.at, inlineCode?.at].filter((at): at is number => at !== undefined);
  cutoff = Math.min(cutoff, ...pending);
  return cutoff < text.length ? text.slice(0, cutoff).trimEnd() : text;
}
