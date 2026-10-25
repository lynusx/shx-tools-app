import { useEffect, type JSX } from 'react'
import { Button, Popconfirm, Space, Table, Tag, Typography, message } from 'antd'
import type { TableProps } from 'antd'
import type { CopySummary, ScanSummary } from '@shared/tool-contract'
import type { TaskRecord } from '@shared/task'
import { useTaskStore } from '../../stores/task-store'
import { isTerminalState, stateColor, stateLabel } from '../../utils/task-status'

export default function TaskListPage(): JSX.Element {
  const tasks = useTaskStore((state) => state.tasks)
  const load = useTaskStore((state) => state.load)

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
      await load()
    } catch (error) {
      void message.error(String(error))
    }
  }

  const columns: TableProps<TaskRecord>['columns'] = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 80,
      render: (kind: TaskRecord['kind']) => (kind === 'scan' ? '扫描' : '复制')
    },
    { title: '工具', dataIndex: 'toolId', width: 120 },
    {
      title: '状态',
      dataIndex: 'state',
      width: 110,
      render: (_: unknown, task) => (
        <Tag color={stateColor(task.state)}>{stateLabel(task.state)}</Tag>
      )
    },
    {
      title: '进度',
      width: 110,
      render: (_: unknown, task) =>
        task.progress ? `${task.progress.done} / ${task.progress.total}` : '—'
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString()
    },
    {
      title: '结果',
      render: (_: unknown, task) => renderResult(task)
    },
    {
      title: '操作',
      width: 220,
      render: (_: unknown, task) => {
        const terminal = isTerminalState(task.state)
        return (
          <Space size={4}>
            {task.state === 'preparing' || task.state === 'running' ? (
              <Button size="small" onClick={() => void act(() => window.shx.task.pause(task.id))}>
                暂停
              </Button>
            ) : null}
            {task.state === 'paused' || task.state === 'interrupted' ? (
              <Button
                size="small"
                type="primary"
                onClick={() => void act(() => window.shx.task.resume(task.id))}
              >
                继续
              </Button>
            ) : null}
            {!terminal ? (
              <Popconfirm
                title="取消后不能继续，已收集的文件保留"
                onConfirm={() => void act(() => window.shx.task.cancel(task.id))}
              >
                <Button size="small" danger>
                  取消
                </Button>
              </Popconfirm>
            ) : null}
            {terminal ? (
              <Popconfirm
                title="删除这条记录？明细文件会一并删除"
                onConfirm={() => void act(() => window.shx.task.remove(task.id))}
              >
                <Button size="small">删除</Button>
              </Popconfirm>
            ) : null}
          </Space>
        )
      }
    }
  ]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          任务中心
        </Typography.Title>
        <Button onClick={() => void load()}>刷新</Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={tasks}
        size="middle"
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
      />
    </Space>
  )
}

function renderResult(task: TaskRecord): string {
  if (task.kind === 'scan') {
    const summary = task.summary as ScanSummary
    if (!summary || summary.dirCount === undefined) return '—'
    return `${summary.dirCount} 目录 / ${summary.fileCount} 文件`
  }
  const summary = task.summary as CopySummary
  if (!summary || !summary.copied) return '—'
  return `${summary.copied.fileCount} 已复制`
}
