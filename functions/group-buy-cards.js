export const action = (label, data) => ({ type: 'postback', label, data: `gb:${data}` });
export function card(title, description, actions) {
  return { type: 'flex', altText: `${title}：${description}`.slice(0, 400), contents: { type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: title, weight: 'bold', size: 'xl', wrap: true },
      { type: 'text', text: description, size: 'sm', color: '#64748B', wrap: true } ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: actions.map(a => ({ type: 'button', style: 'primary', color: '#1664E8', height: 'sm', action: a })) } } };
}
export const welcome = () => card('團購小幫手', '點一下設定團主，就能在這個群組收單。', [action('設定團主', 'bind')]);
export const ready = () => card('準備好收單了', '此群組的 AI 客服已關閉。按下開新團，我會一步步協助你。', [action('開新團', 'new'), action('查看統計', 'stats')]);
export const productCard = state => card(state.product, `每份 ${state.priceCents / 100} 元 · 收單中\n也可以直接輸入 +1、我要三份。每次購買都是追加。`, [action('買 1 份', `buy:${state.roundId}:1`), action('選數量', `quantity:${state.roundId}`), action('我的訂單', `mine:${state.roundId}`), action('團主操作', 'manage')]);
