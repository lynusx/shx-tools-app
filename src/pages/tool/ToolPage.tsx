import { useEffect, useState, type JSX, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  InputNumber,
  Progress,
  Space,
  Statistic,
  Tag,
  Typography,
  message
} from 'antd'
import { useParams } from 'react-router-dom'
import type { CopySummary, ScanSummary, ToolManifest } from '@shared/tool-contract'
import type { TaskRecord } from '@shared/task'
import ImageCollectorForm from './ImageCollectorForm'
import { useTaskStore } from '../../stores/task-store'
import { isTerminalState, stateColor, stateLabel } from '../../utils/task-status'

const SCAN_ACTIVE = ['preparing', 'running']

export default function ToolPage(): JSX.Element {
  const { toolId = 'fake' } = useParams()
  const [tool, setTool] = useState<ToolManifest | null>(null)
  const [dirs, setDirs] = useState(20)
  const [filesPerDir, setFilesPerDir] = useState(5)
  const [delayMs, setDelayMs] = useState(20)
  const [scanId, setScanId] = useState<string | null>(null)
  const [copyId, setCopyId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tasks = useTaskStore((state) => state.tasks)
  const progressMap = useTaskStore((state) => state.progress)

  useEffect(() => {
    void window.shx.tool.list().then((list) => {
      setTool(list.find((item) => item.id === toolId) ?? null)
    })
  }, [toolId])

  const scanTask = tasks.find((task) => task.id === scanId) ?? null
  const copyTask = copyId ? (tasks.find((task) => task.id === copyId) ?? null) : null

  async function startScan(params: Record<string, unknown>): Promise<void> {
    if (!tool) return
    setBusy(true)
    try {
      const task = await window.shx.task.create({
        toolId: tool.id,
        kind: 'scan',
        params
      })
      useTaskStore.getState().upsert(task)
      setScanId(task.id)
      setCopyId(null)
    } catch (error) {
      void message.error(`创建扫描任务失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function startCopy(): Promise<void> {
    if (!scanTask) return
    setBusy(true)
    try {
      const task = await window.shx.task.create({
        toolId: scanTask.toolId,
        kind: 'copy',
        params: { sourceScanId: scanTask.id, delayMs: 5 }
      })
      useTaskStore.getState().upsert(task)
      setCopyId(task.id)
    } catch (error) {
      void message.error(`创建复制任务失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={tool ? `${tool.name}` : toolId}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {tool?.description ?? '正在加载工具清单…'}
        </Typography.Paragraph>
        {tool?.id === 'image-collector' ? (
          <ImageCollectorForm busy={busy} onStart={(params) => void startScan(params)} />
        ) : (
          <Space wrap size={16}>
            <label>
              目录数{' '}
              <InputNumber
                min={1}
                max={20000}
                value={dirs}
                onChange={(value) => setDirs(value ?? 1)}
              />
            </label>
            <label>
              每目录文件数{' '}
              <InputNumber
                min={0}
                max={100}
                value={filesPerDir}
                onChange={(value) => setFilesPerDir(value ?? 0)}
              />
            </label>
            <label>
              每目录耗时(ms){' '}
              <InputNumber
                min={0}
                max={1000}
                value={delayMs}
                onChange={(value) => setDelayMs(value ?? 0)}
              />
            </label>
            <Button
              type="primary"
              loading={busy}
              onClick={() => void startScan({ dirs, filesPerDir, delayMs })}
            >
              开始扫描
            </Button>
          </Space>
        )}
      </Card>

      {scanTask ? (
        <TaskCard
          title="扫描任务"
          task={scanTask}
          event={progressMap[scanTask.id]}
          footer={
            scanTask.state === 'succeeded' && tool?.kinds.includes('copy') ? (
              <Space>
                <Button type="primary" loading={busy} onClick={() => void startCopy()}>
                  开始复制
                </Button>
                <Typography.Text type="secondary">扫描结果已落盘，可被多次复制复用</Typography.Text>
              </Space>
            ) : null
          }
        />
      ) : null}

      {copyTask ? (
        <TaskCard title="复制任务" task={copyTask} event={progressMap[copyTask.id]} footer={null} />
      ) : null}

      {!tool ? <Alert type="warning" message={`工具 ${toolId} 不在注册表中`} showIcon /> : null}
    </Space>
  )
}

interface TaskCardProps {
  title: string
  task: TaskRecord
  event?: { done: number; total: number }
  footer: ReactNode
}

function TaskCard({ title, task, event, footer }: TaskCardProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const done = event?.done ?? task.progress?.done ?? 0
  const total = event?.total ?? task.progress?.total ?? 0
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const terminal = isTerminalState(task.state)

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      void message.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title={
        <Space>
          <span>{title}</span>
          <Tag color={stateColor(task.state)}>{stateLabel(task.state)}</Tag>
        </Space>
      }
      extra={
        <Space>
          {SCAN_ACTIVE.includes(task.state) ? (
            <Button loading={busy} onClick={() => void act(() => window.shx.task.pause(task.id))}>
              暂停
            </Button>
          ) : null}
          {task.state === 'paused' || task.state === 'interrupted' ? (
            <Button
              type="primary"
              loading={busy}
              onClick={() => void act(() => window.shx.task.resume(task.id))}
            >
              继续
            </Button>
          ) : null}
          {!terminal ? (
            <Button
              danger
              loading={busy}
              onClick={() => void act(() => window.shx.task.cancel(task.id))}
            >
              取消
            </Button>
          ) : null}
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Progress percent={percent} status={task.state === 'failed' ? 'exception' : undefined} />
        <Typography.Text type="secondary">
          已处理 {done} / {total}
          {task.progress?.current ? ` · ${task.progress.current}` : ''}
        </Typography.Text>
        <SummaryView task={task} />
        {task.error ? <Alert type="error" showIcon message={task.error.message} /> : null}
        {task.artifacts?.length ? (
          <Space wrap>
            {task.artifacts.map((artifact) => (
              <Button
                key={artifact.path}
                onClick={() => void window.shx.shell.openPath(artifact.path)}
              >
                打开{artifact.label}
              </Button>
            ))}
          </Space>
        ) : null}
        {footer}
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="任务 ID">{task.id}</Descriptions.Item>
          <Descriptions.Item label="开始时间">
            {new Date(task.startedAt).toLocaleString()}
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  )
}

function SummaryView({ task }: { task: TaskRecord }): JSX.Element {
  if (task.kind === 'scan') {
    const summary = task.summary as ScanSummary
    return (
      <Space size={24}>
        <Statistic title="目录" value={summary.dirCount ?? 0} />
        <Statistic title="文件" value={summary.fileCount ?? 0} />
        <Statistic title="字节" value={summary.bytes ?? 0} />
      </Space>
    )
  }

  const summary = task.summary as CopySummary
  return (
    <Space size={24}>
      <Statistic title="计划" value={summary.planned?.fileCount ?? 0} />
      <Statistic title="已复制" value={summary.copied?.fileCount ?? 0} />
      <Statistic title="失败" value={summary.failed?.fileCount ?? 0} />
    </Space>
  )
}
