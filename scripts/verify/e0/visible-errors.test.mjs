// SPDX-License-Identifier: CPAL-1.0
// 运行：node --test scripts/verify/e0/visible-errors.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addVisible, errorLines, isProbe, isUserCommand, judgeVisibleErrors, pageVisibleErrors } from './visible-errors.mjs'
import { judge } from './judge.mjs'

const bash = (command, output, isError = false) => ({ id: command, name: 'Bash', input: { command }, output, isError })

test('CLI 报错行：error: / Error: / npm error / npm ERR! 计数，正常中文提示不计', () => {
  assert.equal(errorLines('error: 先停掉正在运行的服务再重装').length, 1)
  assert.equal(errorLines('npm error 404 Not Found - GET registry/gitrader').length, 1)
  assert.equal(errorLines('npm ERR! code E404\nnpm ERR! 404').length, 2)
  assert.equal(errorLines('  Error: listen EADDRINUSE').length, 1)
  assert.equal(errorLines('\x1b[31merror:\x1b[0m boom').length, 1)
  assert.equal(errorLines('服务已启动，请在浏览器里设置 PIN\nnpm warn deprecated x\nthe error: in the middle').length, 0)
})

test('垫片日志与转录里的同一行只算一次', () => {
  const r = judgeVisibleErrors({
    stderr: [{ src: 'cli', argv: 'serve --port 5', text: 'error: 先停掉正在运行的服务\n' }],
    transcript: [bash('gitrader serve --port 5', 'Exit code 1\nerror: 先停掉正在运行的服务')],
  })
  assert.equal(r.fails.length, 1)
})

test('用户命令非零退出且有输出 = 失败；无 error 前缀也算', () => {
  const r = judgeVisibleErrors({ transcript: [bash('gitrader pin status', 'Exit code 2\nPIN 未设置'), bash('gitrader doctor', 'ok')] })
  assert.equal(r.fails.length, 1); assert.match(r.fails[0].what, /exit 2/)
})

test('npm install gitrader 的 404 算（转录里的用户命令）', () => {
  const r = judgeVisibleErrors({ transcript: [bash('npm install -g gitrader', 'Exit code 1\nnpm error code E404\nnpm error 404 Not Found')] })
  assert.equal(r.fails.length, 2)
})

test('探测性 --help 非零退出只列人工看，不判败', () => {
  const r = judgeVisibleErrors({ transcript: [bash('gitrader risk relax --help', 'Exit code 1\nerror: unknown option'), bash('gitrader --version', 'Exit code 1\nusage')] })
  assert.equal(r.fails.length, 0); assert.equal(r.manual.length, 2)
  const s = judgeVisibleErrors({ stderr: [{ src: 'cli', argv: 'agent --help', text: 'error: x' }] })
  assert.equal(s.fails.length, 0); assert.equal(s.manual.length, 1)
})

test('Agent 读源码 / 非产品命令的输出不算', () => {
  const r = judgeVisibleErrors({ transcript: [bash('grep -rn "error:" src', 'src/a.ts:1:error: x'), bash('cat x.log', 'Exit code 1\nerror: y'), bash('which gitrader', 'Exit code 1\nwhich: no gitrader')] })
  assert.equal(r.fails.length, 0)
  assert.equal(isUserCommand('cd x && GITRADER_HOME=y gitrader serve'), true)
  assert.equal(isProbe('gitrader serve --port 1'), false)
})

test('界面：红色规则行计数；取整提示、待批琥珀行、正常中文不计', () => {
  const v = pageVisibleErrors({ title: 'Gitrader', body: '活动\n数量按精度取整：0.0015 → 0.001', rules: ['超出单笔上限 · 名义 5200 > 5000', '  '] })
  assert.deepEqual(v, [{ kind: 'rule', text: '超出单笔上限 · 名义 5200 > 5000' }])
  assert.deepEqual(pageVisibleErrors({ title: 'Gitrader', body: '待批 T-1\n批准 T-1', rules: [] }), [])
})

test('界面：会话已失效页 / 浏览器错误页', () => {
  assert.equal(pageVisibleErrors({ title: 'Gitrader', body: '会话已失效\n请重新打开链接', rules: [] })[0].kind, 'page')
  assert.match(pageVisibleErrors({ title: '无法访问此网站', body: '127.0.0.1 拒绝了连接。\nERR_CONNECTION_REFUSED', rules: [] })[0].text, /无法访问此网站/)
})

test('同一条红字多次检查点只算一次并累积截图', () => {
  const list = []; addVisible(list, { kind: 'rule', text: 'a' }, 's1.png'); addVisible(list, { kind: 'rule', text: 'a' }, 's2.png'); addVisible(list, { kind: 'toast', text: 'a' }, 's2.png')
  assert.equal(list.length, 2); assert.deepEqual(list[0].shots, ['s1.png', 's2.png'])
  const r = judgeVisibleErrors({ browserVisible: list })
  assert.equal(r.fails.length, 2); assert.match(r.fails[0].what, /s1\.png、s2\.png/)
})

test('judge 接入：j 项非零则不通过，干净则通过，且 a–i 仍在', () => {
  const base = { transcript: [], ledger: [{ seq: 1, type: 'order.intent', ts: 1, payload: { intent: { tpsl: { stopLoss: {} } } } }, { seq: 2, type: 'order.child_linked', ts: 2, payload: { tpslRole: 'sl' } }, { seq: 3, type: 'fill', ts: 3, payload: {} }], humanActions: [{ kind: 'setPin' }, { kind: 'approve' }], startMs: 0 }
  const ok = judge({ ...base, browser: { consoleErrors: [], toastErrors: [], screenCodes: [], visibleErrors: [] } })
  assert.deepEqual(ok.items.map((x) => x.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']); assert.equal(ok.pass, true)
  const bad = judge({ ...base, browser: { consoleErrors: [], toastErrors: [], screenCodes: [], visibleErrors: [{ kind: 'page', text: '会话已失效', shots: ['x.png'] }] } })
  assert.equal(bad.pass, false); assert.equal(bad.items.find((x) => x.id === 'j').count, 1)
})
