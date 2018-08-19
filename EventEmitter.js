class EventEmitter {
  constructor(options = { emitDelay: null }) {
    this._emitDelay = options.emitDelay;

    this._listeners = {};
    this.events = [];
  }

  on(type, listener) {
    this._addListenner(type, listener);
  }

  once(type, listener) {
    this._addListenner(type, listener, true);
  }

  _applyEvents(eventType, eventArguments) {
    const typeListeners = this._listeners[eventType];
    if (!typeListeners || typeListeners.length === 0) return;

    let removableListeners = [];
    for (let [index, value] of typeListeners.entries()) {
      value.fn.apply(null, eventArguments);
      if (value.once) removableListeners.unshift(index);
    }
    removableListeners.forEach(index => typeListeners.splice(index, 1));
  }

  emit(type, ...eventArguments) {
    if (this._emitDelay) setTimeout(() => this._applyEvents(type, eventArguments), this._emitDelay);
    else this._applyEvents(type, eventArguments);
  }

  _addListenner(type, listener, once = false) {
    if (typeof listener !== 'function') throw TypeError('Listener must be a function');
    if (this.events.includes(type)) this._listeners[type].push({ once, fn: listener });
    else {
      this._listeners[type] = [{ once, fn: listener }];
      this.events.push(type);
    }
  }

  destroy() {
    this._listeners = {};
    this.events = [];
  }
}

module.exports = EventEmitter;
