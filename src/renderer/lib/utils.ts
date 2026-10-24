import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui 标准 cn()——clsx 条件拼接 + tailwind-merge 冲突消解 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
