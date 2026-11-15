// SPDX-License-Identifier: CPAL-1.0
// 五个 journey-<venue>.mjs 共用的人机边界：参数解析 → 读环境变量里的密钥 → 建连接器 → 跑旅程 → 打印回执表。
// 退出码：0 全部步骤通过；1 任一步失败（打印脱敏 Problem）；2 用法错误；3 缺少密钥（不发任何请求）。
// 密钥只经环境变量进入进程内存：不打印、不写文件、不进 argv（argv 里只有账号 / 标的 / 数量这类非密钥参数）。
import { EXIT, createRedactor, describeProblem, formatTable, runJourney } from './journey.mjs'
import { REGISTRY_ERROR, assertRegisteredHost, loadRegistry } from './venues-testnet.mjs'

const USAGE_HINT = (spec) => [
  `用法：node tools/testnet/journey-${spec.venue}.mjs [选项]`,
  '',
  '选项：',
  '  --instrument <id>    协议标的 id（缺省 ' + spec.defaultInstrumentId + '）',
  '  --account <id>       协议账户标签（缺省 ' + spec.defaultAccountId + '）',
  '  --size <decimal>     下单量（缺省 ' + spec.defaultSize + '，会被场所步长与最小量修正）',
  '  --base-url <url>     只用于本地镜像 / 假服务器；缺省 ' + spec.baseUrl,
  '  --json               以 JSON 打印步骤（回执表给机器读）',
  '  --help               打印这段说明',
  '',
  `环境变量（只读这些名字，主网密钥的变量名不会被读取）：${spec.credentials.map((c) => c.env).join(' · ')}`,
  `运行环境：${spec.mode}，只访问 ${spec.hosts.join(' / ')}；脚本不会读任何密钥文件。`,
].join('\n')

/** 解析 `--flag value` 形式的参数；未知旗标 → 抛用法错误。 */
export function parseArgs(argv, spec) {
  const options = {
    instrumentId: spec.defaultInstrumentId,
    accountId: spec.defaultAccountId,
    size: spec.defaultSize,
    baseUrl: spec.baseUrl,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--instrument':
        if (!value) throw usageError('--instrument 需要值')
        options.instrumentId = String(value)
        i += 1
        break
      case '--account':
        if (!value) throw usageError('--account 需要值')
        options.accountId = String(value)
        i += 1
        break
      case '--size':
        if (!value) throw usageError('--size 需要值')
        options.size = String(value)
        i += 1
        break
      case '--base-url':
        if (!value) throw usageError('--base-url 需要值')
        options.baseUrl = String(value)
        i += 1
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw usageError(`未知参数：${arg}`)
    }
  }
  return options
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * 测试网基址白名单：只认登记表 tools/testnet/venues-testnet.json 里的主机（本场所那一行），外加本机回环
 * （本地镜像 / 假服务器）。缺省基址也照样查表 —— 某个包的基址常量悄悄漂到未登记主机时，这里先拒，
 * 在读密钥、建连接器之前就退出 2。生产主机（fapi.binance.com、api.alpaca.markets 等）不在表内，同样拒。
 * 场所被登记成「无测试网」（HTX）时单独报错：该场所根本没有可用的官方测试网主机。
 * OKX / Bitget 的模拟盘与生产同主机，登记表里那一行就是该主机；模拟盘由连接器的 environment=testnet 请求头区分。
 */
export function assertTestnetBaseUrl(raw, spec) {
  const text = String(raw).trim().replace(/\/+$/, '')
  let host = ''
  for (const candidate of [text, `tcp://${text}`]) {
    try {
      host = new URL(candidate).hostname.toLowerCase()
      break
    } catch {
      /* 试下一种写法（IBKR 允许裸 host:port） */
    }
  }
  if (host !== '' && LOOPBACK_HOSTS.has(host)) return
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw usageError(`--base-url 只接受 https 地址（本机回环除外）；${text} 解析失败，脚本不连实盘`)
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    // 只回显协议与主机：URL 里夹的凭据不进输出
    throw usageError(`--base-url 只接受 https 地址，且 URL 里不许夹用户名 / 密码；${parsed.protocol}//${parsed.host} 被拒，脚本不连实盘`)
  }
  try {
    assertRegisteredHost(spec?.venue, host, loadRegistry())
    return
  } catch (error) {
    if (error.code === REGISTRY_ERROR.NO_TESTNET) {
      throw usageError(`--base-url 被拒：${error.message}；脚本不连实盘`)
    }
    throw usageError(`--base-url 只接受登记表 tools/testnet/venues-testnet.json 里本场所的测试网 / 模拟盘主机，或本机回环地址（本地镜像 / 假服务器）；${host || text} 不在允许范围内，脚本不连实盘`)
  }
}

function usageError(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  return error
}

/** 只有环境变量里有值才算数；缺哪个就报哪个（只报名，不报值）。 */
export function readCredentials(spec, env) {
  const credentials = {}
  const missing = []
  for (const credential of spec.credentials) {
    const value = env[credential.env]
    if (typeof value !== 'string' || value.trim() === '') missing.push(credential.env)
    else credentials[credential.field] = value
  }
  return { credentials, missing }
}

/**
 * 跑一个场所的 CLI。
 * @param {object} options
 * @param {object} options.spec            venues.mjs 的场所参数
 * @param {string[]} options.argv          process.argv.slice(2)
 * @param {(params:object)=>Promise<object>} options.createConnector  真跑时的连接器工厂（可注入 fetch / clock）
 * @param {object} [options.deps]          { env, stdout, stderr, fetchImpl, clock, sleep, now }
 * @returns {Promise<number>} 退出码
 */
export async function runCli({ spec, argv = [], createConnector, deps = {} }) {
  const env = deps.env ?? process.env
  const write = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`))
  const writeError = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`))

  let options
  try {
    options = parseArgs(argv, spec)
    assertTestnetBaseUrl(options.baseUrl, spec)
  } catch (error) {
    writeError(`参数错误：${error.message}`)
    writeError(USAGE_HINT(spec))
    return EXIT.USAGE
  }
  if (options.help) {
    write(USAGE_HINT(spec))
    return EXIT.OK
  }

  const { credentials, missing } = readCredentials(spec, env)
  const secrets = spec.credentials.map((c) => credentials[c.field]).filter((v) => typeof v === 'string')
  const redact = createRedactor(secrets)
  if (missing.length > 0) {
    writeError(`缺少密钥环境变量：${missing.join('、')}`)
    writeError(redact(`本脚本不发任何请求。请先在当前终端导出：${missing.join(' ')}（只读环境变量，不会落盘；见 tools/testnet/README.md）。`))
    return EXIT.NO_CREDENTIALS
  }

  write(`Gitrader 测试网旅程 · ${spec.venue} · ${spec.mode}`)
  write(redact(`基址 ${options.baseUrl} · 标的 ${options.instrumentId} · 账户 ${options.accountId}`))

  let connector
  try {
    connector = await createConnector({
      credentials,
      environment: spec.environment,
      baseUrl: options.baseUrl,
      instrumentId: options.instrumentId,
      fetchImpl: deps.fetchImpl,
      clock: deps.clock,
    })
  } catch (error) {
    const problem = describeProblem(error, redact)
    writeError(`连接器构造失败：${problem.name} ${problem.message}`)
    return EXIT.FAILED
  }

  let result
  try {
    result = await runJourney({
      venue: spec.venue,
      connector,
      accountId: options.accountId,
      instrumentId: options.instrumentId,
      sizeHint: options.size,
      triggerShape: spec.triggerShape,
      secrets,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      log: (line) => write(redact(line)),
    })
  } finally {
    try {
      await connector.close?.()
    } catch {
      /* 关连接失败不改变旅程结论 */
    }
  }

  if (options.json) {
    write(redact(JSON.stringify({ venue: spec.venue, environment: spec.environment, ok: result.ok, failedStep: result.failedStep, steps: result.steps }, null, 2)))
  } else {
    write('')
    write(redact(formatTable(result.steps)))
    write('')
    const total = result.steps.reduce((sum, step) => sum + (step.ms || 0), 0)
    write(`共 ${result.steps.length} 步 · ${total} ms · ${result.ok ? '全部通过' : `失败于「${result.failedStep}」`}`)
    if (!result.ok) {
      writeError(redact(`Problem: ${JSON.stringify(result.problem)}`))
      writeError('按 README「失败怎么读」一节处理：先查单对账，再决定是否重跑；不要盲目重发下单请求。')
    }
  }
  return result.exitCode
}
