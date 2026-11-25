export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  prefix: "+" | "-" | " " | "@";
  content: string;
}

export interface ParsedDiffResult {
  lines: ParsedDiffLine[];
  additions: number;
  deletions: number;
  statLabel: string;
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/**
 * 纯函数：解析 unified diff 字符串为结构化行列表与增删统计，供三套独立风格各自渲染。
 */
export function parseUnifiedDiff(raw: string): ParsedDiffResult {
  const sourceLines = (raw || "").split(/\r?\n/);
  const lines: ParsedDiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  let additions = 0;
  let deletions = 0;
  let hasHunk = false;

  for (const line of sourceLines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      lines.push({
        kind: "meta",
        oldLine: null,
        newLine: null,
        prefix: " ",
        content: line,
      });
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      hasHunk = true;
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      lines.push({
        kind: "hunk",
        oldLine: null,
        newLine: null,
        prefix: "@",
        content: line,
      });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
      lines.push({
        kind: "add",
        oldLine: null,
        newLine: newNum,
        prefix: "+",
        content: line.slice(1),
      });
      newNum += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
      lines.push({
        kind: "del",
        oldLine: oldNum,
        newLine: null,
        prefix: "-",
        content: line.slice(1),
      });
      oldNum += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      lines.push({
        kind: "context",
        oldLine: oldNum,
        newLine: newNum,
        prefix: " ",
        content: line.slice(1),
      });
      oldNum += 1;
      newNum += 1;
      continue;
    }

    if (!hasHunk && line === "" && sourceLines.length === 1) {
      continue;
    }

    lines.push({
      kind: "context",
      oldLine: oldNum,
      newLine: newNum,
      prefix: " ",
      content: line,
    });
    oldNum += 1;
    newNum += 1;
  }

  return {
    lines,
    additions,
    deletions,
    statLabel: `+${additions} -${deletions}`,
  };
}

/**
 * 纯函数：为非 diff 代码块（bash / json）生成行号结构。
 */
export function splitCodeLines(raw: string): Array<{ lineNo: number; content: string }> {
  if (!raw) return [];
  return raw.split(/\r?\n/).map((content, idx) => ({
    lineNo: idx + 1,
    content,
  }));
}
