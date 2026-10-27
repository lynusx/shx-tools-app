/** 扩展名过滤：扫描阶段决定「什么算一张图」，不在复制阶段补算 */

export function normalizeExtensions(extensions: readonly string[]): string[] {
  const normalized = extensions
    .map((extension) => extension.trim().toLowerCase().replace(/^\./, ''))
    .filter((extension) => extension.length > 0)
  return [...new Set(normalized)]
}

export function matchesExtension(fileName: string, extensions: readonly string[]): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return false
  const extension = fileName.slice(dot + 1).toLowerCase()
  return extensions.includes(extension)
}
