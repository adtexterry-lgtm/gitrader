// SPDX-License-Identifier: CPAL-1.0
// Runtime paths and content pins are supplied only in the isolated temporary home.
export const fakeNotifyManifest = {
  schema: 'gitrader-plugin/1', id: 'connector.test.notify', package: 'block', kind: 'connector',
  name: 'Notification fixture', desc: 'Records test notices locally', tags: ['test'], version: '0.1.0',
  vendor: { id: 'test', name: 'Test', kind: 'self', verified: false, url: null },
  source: { repo: 'local/notify-fixture', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
  license: { spdx: 'CPAL-1.0', redistribute: 'bundle', notice: 'fixture', commercialUse: true },
  runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: './gsp.mjs' },
  install: { by: 'user-install', requireHashes: true }, permissions: [], privacy: { hosted: false, sends: [] },
  provides: { tools: ['notify_send', 'environment_keys'] },
  tools: [
    { name: 'notify_send', desc: 'Records a notice', tags: ['utility'],
      input: { type: 'object', additionalProperties: false, required: ['notice', 'params'], properties: {
        notice: { type: 'object', additionalProperties: false, required: ['key', 'level', 'title', 'lines', 'ts', 'topic'], properties: {
          key: { type: 'string' }, level: { enum: ['info', 'warn', 'critical'] }, title: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } }, ts: { type: 'integer' }, topic: { type: 'string' },
        } }, params: { type: 'object' },
      } },
      output: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { const: true }, ref: { type: 'string' } } },
        { type: 'object', additionalProperties: false, required: ['ok', 'reason', 'retryable'], properties: { ok: { const: false }, reason: { type: 'string' }, retryable: { type: 'boolean' } } },
      ] },
    },
    { name: 'environment_keys', desc: 'Lists environment variable names', tags: ['utility'], input: { type: 'object' } },
  ],
  fixtures: { offline: [], smoke: [] }, compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
}
