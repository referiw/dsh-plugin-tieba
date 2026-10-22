/**
 * 所有运行期路径集中在这里。
 *
 * 默认放 `~/.dsh-tieba/`，可用 `DSH_TIEBA_HOME` 覆盖。
 * 目录内含登录 cookie、配置、抓取缓存、图片，均不进版本库。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME_DIR = process.env.DSH_TIEBA_HOME || path.join(os.homedir(), '.dsh-tieba');

export const COOKIE_FILE = path.join(HOME_DIR, 'cookies.json');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const CACHE_DIR = path.join(HOME_DIR, 'cache');
export const IMAGE_DIR = path.join(HOME_DIR, 'images');
export const PROFILE_DIR = path.join(HOME_DIR, 'profile');

export function ensureHome() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  return HOME_DIR;
}
