"use client";

import React, { useState } from "react";
import { X, UploadCloud, Check, Code } from "lucide-react";

interface UploadPluginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const DEFAULT_MANIFEST = `{
  "name": "my-custom-skill",
  "version": "1.0.0",
  "description": "自定义本地沙箱分析技能",
  "entrypoint": "main.py",
  "permissions": ["exec:sandbox"]
}`;

export function UploadPluginModal({ isOpen, onClose }: UploadPluginModalProps) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [category, setCategory] = useState<"研发工作流" | "代码审查" | "系统集成">("研发工作流");
  const [manifestText, setManifestText] = useState(DEFAULT_MANIFEST);
  const [fileName, setFileName] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setTimeout(() => {
      setSubmitted(false);
      onClose();
    }, 1200);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[#18181C] border border-[#2B2B31] rounded-2xl shadow-2xl p-5 space-y-4 animate-in zoom-in-95 duration-150 select-none max-h-[90vh] overflow-y-auto scrollbar-thin text-codex-text"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline pb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              导入或创建自定义技能
            </h3>
            <p className="text-xs text-codex-muted mt-0.5">
              上传包含 manifest.json 与执行脚本的归档包或代码
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-codex-muted hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-codex-muted mb-1 font-mono text-[11px]">
                技能标识 (Name)
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如: custom-skill"
                className="w-full h-8 px-2.5 rounded-lg bg-[#121215] border border-hairline focus:border-codex-muted text-white outline-none"
              />
            </div>
            <div>
              <label className="block text-codex-muted mb-1 font-mono text-[11px]">
                语义版本 (Version)
              </label>
              <input
                type="text"
                required
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                className="w-full h-8 px-2.5 rounded-lg bg-[#121215] border border-hairline focus:border-codex-muted text-white outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-codex-muted mb-1 font-mono text-[11px]">
              分类类别 (Category)
            </label>
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as "研发工作流" | "代码审查" | "系统集成")
              }
              className="w-full h-8 px-2.5 rounded-lg bg-[#121215] border border-hairline focus:border-codex-muted text-white outline-none"
            >
              <option value="研发工作流">研发工作流</option>
              <option value="代码审查">代码审查</option>
              <option value="系统集成">系统集成</option>
            </select>
          </div>

          {/* 模拟文件上传区域 */}
          <div>
            <label className="block text-codex-muted mb-1 font-mono text-[11px]">
              技能代码包 (.zip)
            </label>
            <label className="border border-dashed border-[#2B2B31] hover:border-neutral-500 rounded-xl p-4 flex flex-col items-center justify-center cursor-pointer transition-colors bg-white/[0.01]">
              <UploadCloud className="w-5 h-5 text-codex-muted mb-1.5" />
              <span className="text-codex-muted hover:text-white">
                {fileName ? fileName : "点击选择或拖拽 .zip 归档文件"}
              </span>
              <span className="text-[10px] text-codex-subtle mt-0.5">
                最大支持 15MB 压缩包
              </span>
              <input
                type="file"
                accept=".zip,.tar.gz"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    setFileName(e.target.files[0].name);
                  }
                }}
              />
            </label>
          </div>

          {/* manifest.json 校验与编辑 */}
          <div>
            <label className="block text-codex-muted mb-1 font-mono text-[11px] flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Code className="w-3.5 h-3.5 text-codex-muted" />
                <span>manifest.json 结构配置</span>
              </span>
              <span className="text-codex-subtle text-[10px]">JSON 语法就绪</span>
            </label>
            <textarea
              rows={5}
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              className="w-full p-2.5 rounded-xl bg-[#121215] border border-hairline font-mono text-[11px] text-[#ECECEE] focus:border-codex-muted outline-none leading-relaxed"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-codex-muted hover:text-white hover:bg-white/[0.04] transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitted}
              className="px-4 py-1.5 rounded-lg font-medium bg-white hover:bg-neutral-200 text-black transition-all flex items-center gap-1.5"
            >
              {submitted ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>已保存</span>
                </>
              ) : (
                <span>保存并安装</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
