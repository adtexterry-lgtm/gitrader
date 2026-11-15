// SPDX-License-Identifier: CPAL-1.0
// 工作台壳的无 DOM 核心（布局引擎、控制器、命令表、会话引导、偏好）。壳的界面在 shell/ 与 app.jsx，由 build.mjs 打成单文件。
export * from './core/workspace'
export * from './core/presets'
export * from './core/controller'
export * from './core/commands'
export * from './core/session'
export * from './core/prefs'
export * from './core/actor'
export * from './core/host-api'
export * from './core/placeholders'
export * from './core/feed-state'
