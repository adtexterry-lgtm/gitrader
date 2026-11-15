// SPDX-License-Identifier: Apache-2.0
// 由 scripts/build-schemas.mjs 生成，勿手改。

import s0 from '../schemas/agent.AgentKey.json'
import s1 from '../schemas/agent.ConfirmTokenClaims.json'
import s2 from '../schemas/agent.ControlIntent.json'
import s3 from '../schemas/agent.Mandate.json'
import s4 from '../schemas/agent.MandateLimits.json'
import s5 from '../schemas/agent.OrderPreviewResult.json'
import s6 from '../schemas/agent.Proposal.json'
import s7 from '../schemas/agent.TakeoverRequest.json'
import s8 from '../schemas/block.json'
import s9 from '../schemas/gep.BacktestResult.json'
import s10 from '../schemas/gep.BacktestSpec.json'
import s11 from '../schemas/gep.BindResult.json'
import s12 from '../schemas/gep.Binding.json'
import s13 from '../schemas/gep.EngineDescribe.json'
import s14 from '../schemas/gep.EngineLaunch.json'
import s15 from '../schemas/gep.EventsPushParams.json'
import s16 from '../schemas/gep.GepEvent.json'
import s17 from '../schemas/gep.GepHelloParams.json'
import s18 from '../schemas/gep.GepHelloResult.json'
import s19 from '../schemas/gep.JsonRpcNotification.json'
import s20 from '../schemas/gep.JsonRpcRequest.json'
import s21 from '../schemas/gep.JsonRpcResponse.json'
import s22 from '../schemas/gep.Methods.json'
import s23 from '../schemas/gep.OrderResult.json'
import s24 from '../schemas/ledger.json'
import s25 from '../schemas/model.Account.json'
import s26 from '../schemas/model.AccountGroup.json'
import s27 from '../schemas/model.Attestation.json'
import s28 from '../schemas/model.BacktestAssumptions.json'
import s29 from '../schemas/model.BacktestEvidencePack.json'
import s30 from '../schemas/model.Balance.json'
import s31 from '../schemas/model.BaselineRef.json'
import s32 from '../schemas/model.Book.json'
import s33 from '../schemas/model.BookSnapshot.json'
import s34 from '../schemas/model.Candle.json'
import s35 from '../schemas/model.Common.json'
import s36 from '../schemas/model.ConnectorAccountSnapshot.json'
import s37 from '../schemas/model.DecisionRecord.json'
import s38 from '../schemas/model.EvidencePack.json'
import s39 from '../schemas/model.EvidencePackBase.json'
import s40 from '../schemas/model.EvidencePackDraft.json'
import s41 from '../schemas/model.EvidencePackRef.json'
import s42 from '../schemas/model.EvidenceRef.json'
import s43 from '../schemas/model.Experiment.json'
import s44 from '../schemas/model.ExperimentAttach.json'
import s45 from '../schemas/model.ExperimentConformanceCase.json'
import s46 from '../schemas/model.ExperimentCreatePatch.json'
import s47 from '../schemas/model.ExperimentExecutor.json'
import s48 from '../schemas/model.ExperimentLlm.json'
import s49 from '../schemas/model.ExperimentMetrics.json'
import s50 from '../schemas/model.ExperimentOwner.json'
import s51 from '../schemas/model.ExperimentPackInput.json'
import s52 from '../schemas/model.ExperimentPatch.json'
import s53 from '../schemas/model.ExperimentRun.json'
import s54 from '../schemas/model.ExperimentToolInput.json'
import s55 from '../schemas/model.ExperimentTransitionEvidence.json'
import s56 from '../schemas/model.Fill.json'
import s57 from '../schemas/model.ForwardConformanceCase.json'
import s58 from '../schemas/model.ForwardEvidencePack.json'
import s59 from '../schemas/model.ForwardFillSlice.json'
import s60 from '../schemas/model.ForwardRunInput.json'
import s61 from '../schemas/model.ForwardSnapshot.json'
import s62 from '../schemas/model.ForwardStats.json'
import s63 from '../schemas/model.ForwardStatsInput.json'
import s64 from '../schemas/model.FundingPayment.json'
import s65 from '../schemas/model.FundingRatePoint.json'
import s66 from '../schemas/model.Instrument.json'
import s67 from '../schemas/model.LabRun.json'
import s68 from '../schemas/model.LossAttribution.json'
import s69 from '../schemas/model.MarginSnapshot.json'
import s70 from '../schemas/model.MarketContext.json'
import s71 from '../schemas/model.ModelTrainedPayload.json'
import s72 from '../schemas/model.OperationRateLimitConfig.json'
import s73 from '../schemas/model.Order.json'
import s74 from '../schemas/model.OrderAmendedPayload.json'
import s75 from '../schemas/model.OrderIntent.json'
import s76 from '../schemas/model.OrderStatusUnknownPayload.json'
import s77 from '../schemas/model.Org.json'
import s78 from '../schemas/model.Origin.json'
import s79 from '../schemas/model.PaperReplayCandle.json'
import s80 from '../schemas/model.PaperReplayConfig.json'
import s81 from '../schemas/model.PaperReplayFixture.json'
import s82 from '../schemas/model.PaperReplayFrame.json'
import s83 from '../schemas/model.PaperReplayProvenance.json'
import s84 from '../schemas/model.PaperReplayStart.json'
import s85 from '../schemas/model.PaperReplayStatus.json'
import s86 from '../schemas/model.Pin.json'
import s87 from '../schemas/model.PluginHealthChangedPayload.json'
import s88 from '../schemas/model.Position.json'
import s89 from '../schemas/model.PrecheckEstimates.json'
import s90 from '../schemas/model.PrecheckResult.json'
import s91 from '../schemas/model.Problem.json'
import s92 from '../schemas/model.Protector.json'
import s93 from '../schemas/model.Quote.json'
import s94 from '../schemas/model.ReconcileAccountView.json'
import s95 from '../schemas/model.ReconcileConfirmInput.json'
import s96 from '../schemas/model.ReconcileConfirmResult.json'
import s97 from '../schemas/model.ReconcileConfirmationReceipt.json'
import s98 from '../schemas/model.ReconcileEvidence.json'
import s99 from '../schemas/model.ReconcileFindingView.json'
import s100 from '../schemas/model.ReconcileNoticeData.json'
import s101 from '../schemas/model.ReconcileResolutionInput.json'
import s102 from '../schemas/model.ReconcileResolutionReceipt.json'
import s103 from '../schemas/model.ReconcileResolveResult.json'
import s104 from '../schemas/model.ReconcileReviewItem.json'
import s105 from '../schemas/model.ReconcileSuggestion.json'
import s106 from '../schemas/model.RiskLimits.json'
import s107 from '../schemas/model.RiskPolicy.json'
import s108 from '../schemas/model.RiskPreset.json'
import s109 from '../schemas/model.RuleHit.json'
import s110 from '../schemas/model.ServerSecurityConfig.json'
import s111 from '../schemas/model.Signal.json'
import s112 from '../schemas/model.SimVenueDeclaration.json'
import s113 from '../schemas/model.TemporaryRelax.json'
import s114 from '../schemas/model.Trade.json'
import s115 from '../schemas/model.TradingScope.json'
import s116 from '../schemas/model.TradingState.json'
import s117 from '../schemas/model.VenueCapabilities.json'
import s118 from '../schemas/model.VenueStatus.json'
import s119 from '../schemas/model.Window.json'
import s120 from '../schemas/plugin.json'
import s121 from '../schemas/risk-gate.json'
import s122 from '../schemas/ui.AccountSummary.json'
import s123 from '../schemas/ui.KeyInfo.json'
import s124 from '../schemas/ui.PresenceProof.json'
import s125 from '../schemas/ui.RiskStateSnapshot.json'
import s126 from '../schemas/ui.RiskUsageItem.json'
import s127 from '../schemas/ui.SessionExchangeError.json'
import s128 from '../schemas/ui.SessionExchangeRequest.json'
import s129 from '../schemas/ui.SessionExchangeResult.json'
import s130 from '../schemas/ui.SettingsSnapshot.json'
import s131 from '../schemas/ui.UiAuthParams.json'
import s132 from '../schemas/ui.UiAuthResult.json'
import s133 from '../schemas/ui.UiCommandParams.json'
import s134 from '../schemas/ui.UiEventParams.json'
import s135 from '../schemas/ui.UiQueryParams.json'
import s136 from '../schemas/ui.UiSubscribeParams.json'
import s137 from '../schemas/ui.UiSubscribeResult.json'
import s138 from '../schemas/ui.UiUnsubscribeParams.json'
import s139 from '../schemas/ui.WorkspaceMeta.json'
import s140 from '../schemas/workflow.json'
import s141 from '../schemas/workspace.json'

export const ALL_SCHEMAS: readonly Record<string, unknown>[] = [
  s0,
  s1,
  s2,
  s3,
  s4,
  s5,
  s6,
  s7,
  s8,
  s9,
  s10,
  s11,
  s12,
  s13,
  s14,
  s15,
  s16,
  s17,
  s18,
  s19,
  s20,
  s21,
  s22,
  s23,
  s24,
  s25,
  s26,
  s27,
  s28,
  s29,
  s30,
  s31,
  s32,
  s33,
  s34,
  s35,
  s36,
  s37,
  s38,
  s39,
  s40,
  s41,
  s42,
  s43,
  s44,
  s45,
  s46,
  s47,
  s48,
  s49,
  s50,
  s51,
  s52,
  s53,
  s54,
  s55,
  s56,
  s57,
  s58,
  s59,
  s60,
  s61,
  s62,
  s63,
  s64,
  s65,
  s66,
  s67,
  s68,
  s69,
  s70,
  s71,
  s72,
  s73,
  s74,
  s75,
  s76,
  s77,
  s78,
  s79,
  s80,
  s81,
  s82,
  s83,
  s84,
  s85,
  s86,
  s87,
  s88,
  s89,
  s90,
  s91,
  s92,
  s93,
  s94,
  s95,
  s96,
  s97,
  s98,
  s99,
  s100,
  s101,
  s102,
  s103,
  s104,
  s105,
  s106,
  s107,
  s108,
  s109,
  s110,
  s111,
  s112,
  s113,
  s114,
  s115,
  s116,
  s117,
  s118,
  s119,
  s120,
  s121,
  s122,
  s123,
  s124,
  s125,
  s126,
  s127,
  s128,
  s129,
  s130,
  s131,
  s132,
  s133,
  s134,
  s135,
  s136,
  s137,
  s138,
  s139,
  s140,
  s141,
]
