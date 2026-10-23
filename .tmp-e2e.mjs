import { Tieba } from './lib/core.mjs';
const tb = new Tieba({ imageQuality: 'both', truncateText: true, maxTextChars: 600 });
tb.cfg.imageQuality = 'both';
const r = await tb.read('11126585157', { refresh: true, maxPages: 1 });
console.log('postedAt:', r.postedAt, '| 总层数:', r.totalFloors, '| 抽样:', r.sampledFloors);
const f = r.floors.find(x => x.images.length);
console.log('楼层号:', f.index, '| 截断:', f.truncated);
console.log(JSON.stringify(f.images, null, 1).slice(0, 900));