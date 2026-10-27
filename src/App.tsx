import { useEffect, useState, type JSX } from 'react'
import { AppstoreOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { Layout, Menu, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { ToolManifest } from '@shared/tool-contract'
import TaskListPage from './pages/task/TaskListPage'
import ToolPage from './pages/tool/ToolPage'
import { subscribeTaskEvents, useTaskStore } from './stores/task-store'

const { Header, Sider, Content } = Layout

const SIDER_WIDTH = 240

export default function App(): JSX.Element {
  const [tools, setTools] = useState<ToolManifest[]>([])
  const [version, setVersion] = useState('')
  const location = useLocation()
  const navigate = useNavigate()

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
      icon: <AppstoreOutlined />,
      label: tool.name
    })),
    { type: 'divider' as const, className: 'app-nav-divider' },
    { key: 'tasks', icon: <UnorderedListOutlined />, label: '任务中心' }
  ]

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'tasks') {
      navigate('/tasks')
      return
    }
    navigate(`/tools/${key.slice('tool:'.length)}`)
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme="light"
        width={SIDER_WIDTH}
        className="app-sider"
        style={{ borderRight: '1px solid #f0f0f0' }}
      >
        <div className="app-brand">
          <Typography.Title level={5} className="app-brand-title">
            shx-tools
          </Typography.Title>
          <Typography.Text type="secondary" className="app-brand-subtitle">
            内部自动化工具箱
          </Typography.Text>
        </div>
        <nav className="app-nav" aria-label="主导航">
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={items}
            onClick={handleMenuClick}
            className="app-menu"
          />
        </nav>
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
