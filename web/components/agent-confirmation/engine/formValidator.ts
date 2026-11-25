import type { FormFieldSchema } from "../types/protocol";

export interface JsonValidationResult {
  valid: boolean;
  errorMessage?: string;
  errorLine?: number;
}

/**
 * 解析 JSON 文本并尽力提取精确错误行号（供 Charcoal/Material/Parchment 实时语法提示使用）。
 */
export function validateJsonString(raw: string): JsonValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true };
  }
  try {
    JSON.parse(trimmed);
    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // V8/Chromium: "... at position 42" 或 "... at line 3 column 5"
    const lineMatch = /line\s+(\d+)/i.exec(msg);
    if (lineMatch) {
      const lineNo = parseInt(lineMatch[1], 10);
      return {
        valid: false,
        errorLine: lineNo,
        errorMessage: `第 ${lineNo} 行 JSON 语法错误：${msg}`,
      };
    }
    const posMatch = /position\s+(\d+)/i.exec(msg);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const prefix = trimmed.slice(0, Math.min(pos, trimmed.length));
      const lineNo = prefix.split(/\r?\n/).length;
      return {
        valid: false,
        errorLine: lineNo,
        errorMessage: `第 ${lineNo} 行 JSON 语法错误`,
      };
    }
    return {
      valid: false,
      errorLine: 1,
      errorMessage: `JSON 语法错误：${msg}`,
    };
  }
}

/**
 * 校验单个表单字段，返回简体中文错误提示或 null。
 */
export function validateSingleField(
  field: FormFieldSchema,
  value: unknown
): string | null {
  const isEmpty =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "");

  if (field.required && isEmpty && field.type !== "boolean") {
    return `请填写「${field.label}」`;
  }
  if (isEmpty) {
    return null;
  }

  if (field.type === "number") {
    const num = typeof value === "number" ? value : Number(String(value).trim());
    if (Number.isNaN(num)) {
      return "请输入有效的数字";
    }
    if (field.min !== undefined && num < field.min) {
      return `数值不能小于 ${field.min}`;
    }
    if (field.max !== undefined && num > field.max) {
      return `数值不能大于 ${field.max}`;
    }
    return null;
  }

  if (field.type === "text" && field.pattern) {
    try {
      const re = new RegExp(field.pattern);
      if (!re.test(String(value))) {
        return `格式不符合要求 (${field.pattern})`;
      }
    } catch {
      // 后端若传入非法正则，不阻塞用户输入
    }
    return null;
  }

  if (field.type === "select" && field.options && field.options.length > 0) {
    const strVal = String(value);
    const valid = field.options.some((o) => o.value === strVal);
    if (!valid) {
      return "请选择有效的候选项";
    }
    return null;
  }

  if (field.type === "json") {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const res = validateJsonString(raw);
    if (!res.valid) {
      return res.errorMessage || "请输入合法的 JSON 格式";
    }
    return null;
  }

  return null;
}

/**
 * 校验整组表单字段，返回 key -> 错误文案 的映射对象。
 */
export function validateFormFields(
  fields: FormFieldSchema[],
  values: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const err = validateSingleField(field, values[field.key]);
    if (err) {
      errors[field.key] = err;
    }
  }
  return errors;
}

/**
 * 构建表单初始默认值。
 */
export function buildInitialFormValues(
  fields: FormFieldSchema[]
): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default_value !== undefined) {
      init[field.key] =
        field.type === "json" && typeof field.default_value !== "string"
          ? JSON.stringify(field.default_value, null, 2)
          : field.default_value;
    } else if (field.type === "boolean") {
      init[field.key] = false;
    } else if (field.type === "select" && field.options && field.options.length > 0) {
      init[field.key] = field.options[0].value;
    } else {
      init[field.key] = "";
    }
  }
  return init;
}
