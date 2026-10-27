import { useState, type JSX } from 'react'
import { Alert, Button, Col, Form, Input, Row, Select, Switch } from 'antd'

type ProductType = 'lipo' | 'lixite' | 'el'

interface MachineInput {
  code: string
  root: string
  region: string
}

interface Props {
  busy: boolean
  onStart: (params: Record<string, unknown>) => void
}

const PRODUCT_OPTIONS = [
  { value: 'lipo', label: '利珀' },
  { value: 'lixite', label: '力禧特' },
  { value: 'el', label: 'EL' }
]

const REGION_OPTIONS = [
  { value: '东区', label: '东区' },
  { value: '西区', label: '西区' }
]

const SHIFT_OPTIONS = [
  { value: '白班', label: '白班' },
  { value: '夜班', label: '夜班' }
]

function today(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function splitList(text: string): string[] {
  return text
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseMachines(
  text: string,
  productType: ProductType,
  entryPath: string,
  region: string
): { machines: MachineInput[]; invalid: string[] } {
  const machines: MachineInput[] = []
  const invalid: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    const code = (separator >= 0 ? trimmed.slice(0, separator) : trimmed).trim()
    let root = separator >= 0 ? trimmed.slice(separator + 1).trim() : ''

    // EL 的机台根 = 入口 + 目录名，允许只写机台编码
    if (!root && productType === 'el' && entryPath) {
      root = `${entryPath.replace(/[\\/]+$/, '')}\\${code}`
    }

    if (!code || !root) {
      invalid.push(trimmed)
      continue
    }
    machines.push({ code, root, region })
  }

  return { machines, invalid }
}

export default function ImageCollectorForm({ busy, onStart }: Props): JSX.Element {
  const [productType, setProductType] = useState<ProductType>('lipo')
  const [region, setRegion] = useState('东区')
  const [entryPath, setEntryPath] = useState('')
  const [machinesText, setMachinesText] = useState('')
  const [date, setDate] = useState(today())
  const [shift, setShift] = useState('白班')
  const [hoursText, setHoursText] = useState('')
  const [defectsText, setDefectsText] = useState('')
  const [subDir, setSubDir] = useState('SaveImages')
  const [extensionsText, setExtensionsText] = useState('jpg,png,bmp')
  const [dedupe, setDedupe] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(): void {
    const { machines, invalid } = parseMachines(machinesText, productType, entryPath, region)
    if (invalid.length > 0) {
      setError(`这些机台缺少根路径（写成「编码=根路径」）：${invalid.join('；')}`)
      return
    }
    if (machines.length === 0) {
      setError('至少填一台机台，每行一条')
      return
    }

    const defects = defectsText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (defects.length === 0) {
      setError('至少填一个不良类型')
      return
    }

    setError(null)
    onStart({
      entryPath,
      entryForm: 'shortcut',
      productType,
      machines,
      date,
      shift,
      hourSlots: splitList(hoursText),
      defects,
      extensions: splitList(extensionsText),
      dedupe,
      ...(productType === 'lixite' ? { subDir } : {})
    })
  }

  return (
    <Form layout="vertical">
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 16 }}
          closable
          onClose={() => setError(null)}
        />
      ) : null}

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item label="产品类型">
            <Select value={productType} options={PRODUCT_OPTIONS} onChange={setProductType} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label="区域">
            <Select value={region} options={REGION_OPTIONS} onChange={setRegion} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label="日期">
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item label="入口路径（可选，EL 用于拼接机台根）">
        <Input
          value={entryPath}
          placeholder="\\\\10.108.164.2\\qj-dc-el\\DC"
          onChange={(event) => setEntryPath(event.target.value)}
        />
      </Form.Item>

      <Form.Item
        label="机台（每行一条：编码=根路径）"
        extra="例如 6B=\\\\10.108.9.153；EL 可只写机台编码，根路径由入口拼出"
      >
        <Input.TextArea
          rows={3}
          value={machinesText}
          placeholder={'6B=\\\\10.108.9.153\n7A=\\\\10.108.9.154'}
          onChange={(event) => setMachinesText(event.target.value)}
        />
      </Form.Item>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item label="班次">
            <Select value={shift} options={SHIFT_OPTIONS} onChange={setShift} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label="时段" extra="逗号分隔；留空表示该班次全部">
            <Input
              value={hoursText}
              placeholder="08,09,10"
              onChange={(event) => setHoursText(event.target.value)}
            />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label="扩展名">
            <Input
              value={extensionsText}
              onChange={(event) => setExtensionsText(event.target.value)}
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={productType === 'lixite' ? 16 : 24}>
          <Form.Item label="不良类型（每行一个）">
            <Input.TextArea
              rows={3}
              value={defectsText}
              placeholder={'明暗片\nNG_连续性断栅_A-'}
              onChange={(event) => setDefectsText(event.target.value)}
            />
          </Form.Item>
        </Col>
        {productType === 'lixite' ? (
          <Col span={8}>
            <Form.Item label="子目录">
              <Select
                value={subDir}
                onChange={setSubDir}
                options={[
                  { value: 'SaveImages', label: 'SaveImages' },
                  { value: 'el', label: 'el' }
                ]}
              />
            </Form.Item>
          </Col>
        ) : null}
      </Row>

      <Row gutter={16} align="middle">
        <Col span={8}>
          <Form.Item label="内容去重（SHA-256）" style={{ marginBottom: 0 }}>
            <Switch checked={dedupe} onChange={setDedupe} />
          </Form.Item>
        </Col>
        <Col span={16} style={{ textAlign: 'right' }}>
          <Button type="primary" loading={busy} onClick={submit}>
            开始扫描
          </Button>
        </Col>
      </Row>
    </Form>
  )
}
