// SPDX-License-Identifier: CPAL-1.0
export type Lang = 'zh' | 'en'
export function pickLang(saved: unknown, navLang: string | undefined): Lang
export function getLang(): Lang
export function setLang(l: Lang | null): void
export function applyHtmlLang(): void
export function intlLocale(): 'zh-CN' | 'en-US'
export function missingKeys(): string[]
/** 中文原文当键；{0}{1}… 占位。参数含节点时返回数组。 */
export function t(zh: string, ...args: unknown[]): string
export function tk(text: string, quiet?: boolean): string
