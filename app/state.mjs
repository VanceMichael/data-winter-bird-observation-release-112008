// 进程内账本：保留全部历史版本与发布流，公开出口在序列化时再做隔离。
export class Ledger {
  constructor() {
    this.observations = new Map(); // item -> observation（含版本史）
    this.patrols = new Map();      // org:patrolId -> 实际走完的巡线
    this.facts = [];               // 缺页/缺附件/零只事实
    this.groups = new Map();       // 已核对同次观察 event -> group
    this.manualCandidates = [];    // 未核对近似记录，仅人工提示
    this.permissions = [];         // 许可流原始事件
    this.releases = [];            // 发布/撤回流水（发布号单调递增）
    this.acks = [];                // 订阅方确认范围
    this.rounds = [];              // 每轮同步证据快照
    this.coverage = [];            // 最近一轮的完整片区覆盖（含区间与原因）
    this.sequence = 0;
  }

  nextRoundInput() {
    return this.rounds.length + 1;
  }
}
