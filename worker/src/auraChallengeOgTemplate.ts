import type { ReactElementLike } from 'takumi-js';

export const AURA_CHALLENGE_OG_VERSION = 'aura-score-v1';
export const AURA_CHALLENGE_OG_WIDTH = 1200;
export const AURA_CHALLENGE_OG_HEIGHT = 630;

function element(type: string, className: string, ...children: (ReactElementLike | string)[]): ReactElementLike {
  return { type, props: { className, children } };
}

export function buildAuraChallengeOgDocument(input: { name: string; score: number; difficulty: string }): { node: ReactElementLike; css: string } {
  const score = input.score.toLocaleString('en-US');
  // Text children remain text, including names containing markup characters.
  // The image renderer never parses the chosen name as HTML or fetches it.
  const e = element;
  return {
    node: e('div', 'card',
      e('div', 'top', e('div', 'brand', e('div', 'mark', 'P1'), e('span', '', 'INSERT PLAYER')), e('div', 'challenge', 'AURA CHALLENGE')),
      e('div', 'main',
        e('div', 'result', e('div', 'name', input.name), e('div', 'set', 'SET THE SCORE TO BEAT'),
          e('div', `score ${score.length > 10 ? 'score-small' : ''}`, score), e('div', 'aura', 'AURA'),
          e('div', 'ask', e('span', '', 'CAN YOU'), e('span', '', 'BEAT ME?'))),
        e('div', 'game', e('div', 'room', 'OWN THE ROOM'),
          e('div', 'lanes',
            e('div', 'lane cyan', e('i', 'note n1'), e('i', 'note n5'), e('b', '', 'D')),
            e('div', 'lane violet', e('i', 'note n2'), e('b', '', 'F')),
            e('div', 'lane gold', e('i', 'note n3'), e('b', '', 'J')),
            e('div', 'lane red', e('i', 'note n4'), e('i', 'note n6'), e('b', '', 'K'))),
          e('div', 'play', 'YOUR TURN', e('span', '', '>')))),
      e('div', 'bottom', e('div', '', e('strong', '', 'SAME SONG. SAME MOVES.'),
        e('span', '', `${input.difficulty.toUpperCase()} · PLAY FREE · FRIENDLY SCORE`)), e('b', '', 'insertplayer.ai'))),
    css: `*{box-sizing:border-box} .card{width:1200px;height:630px;display:flex;flex-direction:column;background:#090b18;color:#fff4d6;padding:36px 42px 28px;border:8px solid #ffce3a;font-family:'Space Grotesk';position:relative;overflow:hidden}
    .top{height:54px;display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:16px;font-size:22px;font-weight:700;letter-spacing:2px}.mark{width:50px;height:48px;background:#ffce3a;color:#090b18;display:flex;align-items:center;justify-content:center;font-family:'Press Start 2P';font-size:16px}.challenge{font-size:15px;font-family:'Press Start 2P';color:#4fdced}
    .main{display:flex;flex:1;gap:40px;padding-top:28px}.result{width:670px;display:flex;flex-direction:column}.name{font-size:28px;font-weight:700;max-width:660px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.set{font-size:13px;letter-spacing:2px;color:#b8b7c9;margin-top:7px}.score{font-size:83px;line-height:1.05;font-weight:700;color:#ffce3a;letter-spacing:-3px;margin-top:6px}.score-small{font-size:48px;letter-spacing:-1px}.aura{font-family:'Press Start 2P';font-size:16px;letter-spacing:6px;color:#ffce3a;margin-top:4px}.ask{display:flex;flex-direction:column;font-family:'Press Start 2P';font-size:44px;line-height:1.38;margin-top:22px;color:#fff4d6}
    .game{width:340px;display:flex;flex-direction:column;border:2px solid #37394d;background:#111426}.room{font-size:14px;letter-spacing:3px;text-align:center;color:#b8b7c9;padding:16px 0}.lanes{display:flex;flex:1;padding:0 13px;gap:9px}.lane{display:flex;flex:1;position:relative;border-left:1px solid #34364b;border-right:1px solid #34364b;background:#090b18;align-items:flex-end;justify-content:center;padding-bottom:9px}.lane b{font-size:32px;width:54px;height:46px;display:flex;align-items:center;justify-content:center;border:2px solid currentColor}.lane b .left{transform:rotate(-90deg)}.lane b .right{transform:rotate(90deg)}.cyan{color:#4fdced}.violet{color:#b28aff}.gold{color:#ffce3a}.red{color:#ff6474}.note{position:absolute;width:44px;height:13px;left:5px;background:currentColor;border:2px solid #fff4d6}.n1{top:35px}.n2{top:101px}.n3{top:164px}.n4{top:71px}.n5{top:193px}.n6{top:141px}.play{background:#ffce3a;color:#090b18;display:flex;align-items:center;justify-content:space-between;padding:13px 18px;font-family:'Press Start 2P';font-size:16px;margin-top:12px}.play span{font-family:'Space Grotesk';font-size:26px;line-height:1}
    .bottom{display:flex;align-items:flex-end;justify-content:space-between;border-top:2px solid #34364b;padding-top:17px;margin-top:24px}.bottom div{display:flex;flex-direction:column;gap:6px}.bottom strong{font-size:16px;letter-spacing:1px}.bottom span{font-size:12px;color:#b8b7c9;letter-spacing:1px}.bottom b{font-size:26px;color:#ffce3a}`,
  };
}
