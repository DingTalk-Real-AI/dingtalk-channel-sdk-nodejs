/**
 * 生命周期钩子。
 */

/**
 * 管理连接生命周期钩子
 */
export class LifecycleHooks {
  constructor() {
    this._onReady = [];
    this._onError = [];
    this._onReconnecting = [];
    this._onReconnected = [];
    this._onDisconnected = [];
  }

  /**
   * 注册连接就绪回调
   * @param {Function} fn
   */
  onReady(fn) {
    this._onReady.push(fn);
  }

  /**
   * 注册连接错误回调
   * @param {Function} fn
   */
  onError(fn) {
    this._onError.push(fn);
  }

  /**
   * 注册重连中回调
   * @param {Function} fn
   */
  onReconnecting(fn) {
    this._onReconnecting.push(fn);
  }

  /**
   * 注册重连成功回调
   * @param {Function} fn
   */
  onReconnected(fn) {
    this._onReconnected.push(fn);
  }

  /**
   * 注册断开连接回调
   * @param {Function} fn
   */
  onDisconnected(fn) {
    this._onDisconnected.push(fn);
  }

  /**
   * 触发所有 onReady 回调
   */
  fireReady() {
    for (const fn of this._onReady) {
      try {
        fn();
      } catch (err) {
        // ignore
      }
    }
  }

  /**
   * 触发所有 onError 回调
   * @param {Error} err
   */
  fireError(err) {
    for (const fn of this._onError) {
      try {
        fn(err);
      } catch (e) {
        // ignore
      }
    }
  }

  /**
   * 触发所有 onReconnecting 回调
   */
  fireReconnecting() {
    for (const fn of this._onReconnecting) {
      try {
        fn();
      } catch (err) {
        // ignore
      }
    }
  }

  /**
   * 触发所有 onReconnected 回调
   */
  fireReconnected() {
    for (const fn of this._onReconnected) {
      try {
        fn();
      } catch (err) {
        // ignore
      }
    }
  }

  /**
   * 触发所有 onDisconnected 回调
   */
  fireDisconnected() {
    for (const fn of this._onDisconnected) {
      try {
        fn();
      } catch (err) {
        // ignore
      }
    }
  }
}
