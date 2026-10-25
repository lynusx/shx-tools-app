import { useEffect, useState, type JSX } from 'react'
import { Layout, Menu, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ToolManifest } from '@shared/tool-contract'
import TaskListPage from './pages/task/TaskListPage'
import ToolPage from './pages/tool/ToolPage'
import { subscribeTaskEvents, useTaskStore } from './stores/task-store'

const { Header, Sider, Content } = Layout

export default function App(): JSX.Element {
  const [tools, setTools] = useState<ToolManifest[]>([])
  const [version, setVersion] = useState('')
  const location = useLocation()

  useEffect(() => {
    void window.shx.tool.list().then(setTools)
    void window.shx.app.version().then((info) => setVersion(info.version))
    void useTaskStore.getState().load()
    return subscribeTaskEvents()
  }, [])

  const selectedKey = location.pathname.startsWith('/tasks')
    ? 'tasks'
    : `tool:${location.pathname.split('/')[2] ?? ''}`

  const items: MenuProps['items'] = [
    ...tools.map((tool) => ({
      key: `tool:${tool.id}`,
      label: <NavLink to={`/tools/${tool.id}`}>{tool.name}</NavLink>
    })),
    { key: 'tasks', label: <NavLink to="/tasks">任务中心</NavLink> }
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={208} style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '20px 16px 12px' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            shx-tools
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            内部自动化工具箱
          </Typography.Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header className="app-title" style={{ height: 48, lineHeight: '48px' }}>
          <Typography.Text strong>任务骨架 · M0</Typography.Text>
          <Typography.Text type="secondary">v{version}</Typography.Text>
        </Header>
        <Content className="page">
          <Routes>
            <Route
              path="/"
              element={<Navigate to={tools[0] ? `/tools/${tools[0].id}` : '/tools/fake'} replace />}
            />
            <Route path="/tools/:toolId" element={<ToolPage />} />
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  )
}
