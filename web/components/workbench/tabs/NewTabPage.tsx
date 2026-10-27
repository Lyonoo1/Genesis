"use client";

import React from "react";

interface NewTabPageProps {
  onNavigate: (url: string) => void;
}

export function NewTabPage({ onNavigate }: NewTabPageProps) {
  return (
    <div className="w-full h-full bg-[#141416] select-none flex flex-col items-center justify-center p-6 text-[#8E8E93]" />
  );
}
