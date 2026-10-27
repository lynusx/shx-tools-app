/**
 * Shell Link (.lnk) 解析：纯函数，输入 Buffer，输出结构化结果，不访问文件系统。
 *
 * 目标：F1 入口扫描要从快捷方式里拿到机台根（UNC）。真实样本的目标藏在
 * `EnvironmentVariableDataBlock` 而不是 `LinkInfo`，且 `PropertyStore` 可能是
 * 创建快捷方式时的模板残留——所以这里按 F1 §2.8 的来源优先级与互斥规则处理。
 *
 * 参考：《F1 图片收集设计》§2.8（含 8 个真实样本的实测表）。
 */

export type LnkTargetSource = 'linkInfo' | 'envVar' | 'propStore'
export type LnkEncoding = 'utf16' | 'gbk'

export interface ParsedLnk {
  /** 按优先级解析出的目标；全部为空时为 null */
  target: string | null
  targetSource: LnkTargetSource | null
  /** 强来源互斥：EnvVar 的 U≠A 主机不同，或 LinkInfo 与 EnvVar 主机不同 */
  conflict: boolean
  /** 冲突时的候选路径（去重，按可信度排序） */
  conflictCandidates: string[]
  /** PropertyStore 与采纳值不同：仅告警，不阻断 */
  propertyStoreMismatch?: string
  encoding: LnkEncoding
  brokenReason?: string
}

const HEADER_SIZE = 0x4c
const CLSID = Buffer.from('0114020000000000c000000000000046', 'hex')

const FLAG_HAS_ID_LIST = 0x01
const FLAG_HAS_LINK_INFO = 0x02
const FLAG_HAS_NAME = 0x04
const FLAG_HAS_RELATIVE_PATH = 0x08
const FLAG_HAS_WORKING_DIR = 0x10
const FLAG_HAS_ARGUMENTS = 0x20
const FLAG_HAS_ICON_LOCATION = 0x40
const FLAG_IS_UNICODE = 0x80

const SIG_ENVIRONMENT = 0xa0000001
const SIG_PROPERTY_STORE = 0xa0000009

/** EnvVar 块内 TargetUnicode 的块内偏移；TargetAnsi 在 8，长度 260 */
const ENV_ANSI_OFFSET = 8
const ENV_UNICODE_OFFSET = 268
const ENV_UNICODE_BYTES = 520

let gbkDecoder: TextDecoder | null = null

function decodeAnsi(bytes: Buffer): string {
  try {
    gbkDecoder ??= new TextDecoder('gbk')
    return gbkDecoder.decode(bytes)
  } catch {
    // 极少数 Node 构建没有 GBK 解码器，退回 latin1：至少保证 ASCII 路径可用
    return bytes.toString('latin1')
  }
}

function readUtf16Z(buf: Buffer, start: number, end: number): string {
  let stop = start
  while (stop + 1 < end) {
    if (buf[stop] === 0 && buf[stop + 1] === 0) break
    stop += 2
  }
  return buf.subarray(start, Math.min(stop, end)).toString('utf16le')
}

function readAnsiZ(buf: Buffer, start: number, end: number): string {
  let stop = start
  while (stop < end && buf[stop] !== 0) stop += 1
  return decodeAnsi(buf.subarray(start, stop))
}

/** 主机名只对 UNC 有意义；本地路径返回 null，不参与互斥判定 */
function uncHost(path: string): string | null {
  const match = /^\\\\([^\\/]+)/.exec(path)
  return match?.[1] ? match[1].toLowerCase() : null
}

function isUnc(path: string): boolean {
  return uncHost(path) !== null
}

function normalize(path: string): string {
  return path.replace(/\\+$/, '').toLowerCase()
}

/**
 * PropertyStore 是序列化的属性存储，完整解析成本高且只用于诊断。
 * 这里在块内按 UTF-16LE 扫描 UNC 字符串：真实样本里 System.ItemFolderPathDisplay
 * 以明文 UTF-16 存放，扫描能稳定取到；取不到就当没有。
 */
function extractPropStorePath(body: Buffer): string | null {
  for (const align of [0, 1]) {
    const text = body.subarray(align).toString('utf16le')
    let index = text.indexOf('\\\\')
    while (index !== -1) {
      let end = index + 2
      while (end < text.length && text.charCodeAt(end) >= 0x20) end += 1
      const candidate = text.slice(index, end).trim()
      if (candidate.length > 2 && isUnc(candidate)) return candidate
      index = text.indexOf('\\\\', end)
    }
  }
  return null
}

interface LinkInfoResult {
  target: string | null
  encoding: LnkEncoding
}

/** LinkInfo 段：优先 Unicode 字段，回退 ANSI；段内偏移均相对 LinkInfo 起点 */
function parseLinkInfo(buf: Buffer, start: number): LinkInfoResult | null {
  if (start + 0x1c > buf.length) return null
  const size = buf.readUInt32LE(start)
  const headerSize = buf.readUInt32LE(start + 4)
  if (size < 0x1c || start + size > buf.length) return null

  const flags = buf.readUInt32LE(start + 8)
  const localBasePathOffset = buf.readUInt32LE(start + 16)
  const commonNetworkOffset = buf.readUInt32LE(start + 20)
  const suffixOffset = buf.readUInt32LE(start + 24)

  let localBaseUnicodeOffset = 0
  let suffixUnicodeOffset = 0
  if (headerSize >= 0x24 && start + 0x24 <= buf.length && size >= 0x24) {
    localBaseUnicodeOffset = buf.readUInt32LE(start + 28)
    suffixUnicodeOffset = buf.readUInt32LE(start + 32)
  }

  const readAt = (relative: number, unicode: boolean): string | null => {
    const offset = start + relative
    if (relative <= 0 || offset >= start + size) return null
    const end = start + size
    return unicode ? readUtf16Z(buf, offset, end) : readAnsiZ(buf, offset, end)
  }

  const suffixUnicode = readAt(suffixUnicodeOffset, true)
  const suffixAnsi = readAt(suffixOffset, false)

  if (flags & 0x2) {
    const cnrlStart = start + commonNetworkOffset
    if (commonNetworkOffset > 0 && cnrlStart + 0x1c <= buf.length) {
      const cnrlSize = buf.readUInt32LE(cnrlStart)
      const netNameOffset = buf.readUInt32LE(cnrlStart + 8)
      const netNameUnicodeOffset = cnrlSize >= 0x1c ? buf.readUInt32LE(cnrlStart + 20) : 0

      const netUnicode =
        netNameUnicodeOffset > 0 && cnrlStart + netNameUnicodeOffset < start + size
          ? readUtf16Z(buf, cnrlStart + netNameUnicodeOffset, Math.min(buf.length, start + size))
          : ''
      const netAnsi =
        netNameOffset > 0 && cnrlStart + netNameOffset < start + size
          ? readAnsiZ(buf, cnrlStart + netNameOffset, Math.min(buf.length, start + size))
          : ''

      if (netUnicode) return { target: netUnicode + (suffixUnicode ?? ''), encoding: 'utf16' }
      if (netAnsi) return { target: netAnsi + (suffixAnsi ?? ''), encoding: 'gbk' }
    }
  }

  if (flags & 0x1) {
    const baseUnicode = readAt(localBaseUnicodeOffset, true)
    const baseAnsi = readAt(localBasePathOffset, false)
    if (baseUnicode) return { target: baseUnicode + (suffixUnicode ?? ''), encoding: 'utf16' }
    if (baseAnsi) return { target: baseAnsi + (suffixAnsi ?? ''), encoding: 'gbk' }
  }

  return null
}

/** 按 LinkFlags 步进，返回 ExtraData 起始偏移；越界返回 null */
function locateExtraData(buf: Buffer, flags: number): number | null {
  let offset = HEADER_SIZE

  if (flags & FLAG_HAS_ID_LIST) {
    if (offset + 2 > buf.length) return null
    const idListSize = buf.readUInt16LE(offset)
    offset += 2 + idListSize
  }

  if (flags & FLAG_HAS_LINK_INFO) {
    if (offset + 4 > buf.length) return null
    const linkInfoSize = buf.readUInt32LE(offset)
    if (linkInfoSize < 4) return null
    offset += linkInfoSize
  }

  const isUnicode = (flags & FLAG_IS_UNICODE) !== 0
  for (const flag of [
    FLAG_HAS_NAME,
    FLAG_HAS_RELATIVE_PATH,
    FLAG_HAS_WORKING_DIR,
    FLAG_HAS_ARGUMENTS,
    FLAG_HAS_ICON_LOCATION
  ]) {
    if (!(flags & flag)) continue
    if (offset + 2 > buf.length) return null
    const cch = buf.readUInt16LE(offset)
    offset += 2 + cch * (isUnicode ? 2 : 1)
  }

  return offset <= buf.length ? offset : null
}

export function parseLnk(buf: Buffer): ParsedLnk {
  const broken = (reason: string): ParsedLnk => ({
    target: null,
    targetSource: null,
    conflict: false,
    conflictCandidates: [],
    encoding: 'utf16',
    brokenReason: reason
  })

  if (buf.length < HEADER_SIZE) return broken('文件长度不足 76 字节')
  if (buf.readUInt32LE(0) !== HEADER_SIZE) return broken('HeaderSize 不是 0x4C')
  if (!buf.subarray(4, 20).equals(CLSID)) return broken('LinkCLSID 不匹配')

  const flags = buf.readUInt32LE(0x14)
  const extraOffset = locateExtraData(buf, flags)
  if (extraOffset === null) return broken('按 LinkFlags 步进时越界')

  let linkInfo: LinkInfoResult | null = null
  if (flags & FLAG_HAS_LINK_INFO) {
    let offset = HEADER_SIZE
    if (flags & FLAG_HAS_ID_LIST) offset += 2 + buf.readUInt16LE(offset)
    linkInfo = parseLinkInfo(buf, offset)
  }

  let envUnicode = ''
  let envAnsi = ''
  let propStore: string | null = null

  let offset = extraOffset
  while (offset + 8 <= buf.length) {
    const blockSize = buf.readUInt32LE(offset)
    if (blockSize < 4 || offset + blockSize > buf.length) break
    const signature = buf.readUInt32LE(offset + 4)

    if (signature === SIG_ENVIRONMENT) {
      const blockEnd = offset + blockSize
      const ansiEnd = Math.min(offset + ENV_UNICODE_OFFSET, blockEnd)
      envAnsi = readAnsiZ(buf, offset + ENV_ANSI_OFFSET, ansiEnd)
      const unicodeStart = offset + ENV_UNICODE_OFFSET
      if (unicodeStart < blockEnd) {
        envUnicode = readUtf16Z(
          buf,
          unicodeStart,
          Math.min(unicodeStart + ENV_UNICODE_BYTES, blockEnd)
        )
      }
    } else if (signature === SIG_PROPERTY_STORE) {
      propStore = extractPropStorePath(buf.subarray(offset + 8, offset + blockSize))
    }

    offset += blockSize
  }

  const strongTarget = linkInfo?.target || envUnicode || envAnsi || null

  const target = strongTarget ?? propStore
  const targetSource: LnkTargetSource | null = linkInfo?.target
    ? 'linkInfo'
    : envUnicode || envAnsi
      ? 'envVar'
      : propStore
        ? 'propStore'
        : null

  const encoding: LnkEncoding =
    linkInfo?.target !== undefined && linkInfo.target !== null
      ? linkInfo.encoding
      : envUnicode
        ? 'utf16'
        : envAnsi
          ? 'gbk'
          : 'utf16'

  const conflictCandidates: string[] = []
  const pushCandidate = (value: string): void => {
    if (value && !conflictCandidates.includes(value)) conflictCandidates.push(value)
  }

  let conflict = false
  const envUHost = uncHost(envUnicode)
  const envAHost = uncHost(envAnsi)
  if (envUnicode && envAnsi && envUHost && envAHost && envUHost !== envAHost) {
    conflict = true
    pushCandidate(envUnicode)
    pushCandidate(envAnsi)
  }

  const linkHost = linkInfo?.target ? uncHost(linkInfo.target) : null
  const envChosen = envUnicode || envAnsi
  const envChosenHost = uncHost(envChosen)
  if (linkHost && envChosenHost && linkHost !== envChosenHost) {
    conflict = true
    pushCandidate(linkInfo?.target ?? '')
    pushCandidate(envChosen)
  }

  if (!target) return broken('EnvVar / LinkInfo / PropertyStore 均无可用路径')

  const propertyStoreMismatch =
    propStore && normalize(propStore) !== normalize(target) ? propStore : undefined

  return {
    target,
    targetSource,
    conflict,
    conflictCandidates,
    propertyStoreMismatch,
    encoding
  }
}
