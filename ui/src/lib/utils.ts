import clsx, { type ClassValue } from "clsx"

/** 合并 className（本项目用 clsx；未装 tailwind-merge，冲突类以生成的 CSS 顺序为准） */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
