// SPDX-License-Identifier: CPAL-1.0
// 通知页与交易所页共用同一份 config.view（设置页的两组块读同一个接口），夹具直接引用。
import { venuesFixtures } from './venues'

export const notifyFixtures = {
  normal: venuesFixtures.normal,
  empty: { queries: { 'config.view': venuesFixtures.empty.queries['config.view'], 'plugin.list': [] } },
  loading: venuesFixtures.normal,
  error: {},
  offline: venuesFixtures.normal,
  unwired: {},
}
