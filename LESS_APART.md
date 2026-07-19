# Less Apart fork

This repository is the writable VDO.Ninja fork used by Less Apart.

- Release branch: `less-apart`
- Upstream: `https://github.com/steveseguin/vdo.ninja` (`develop`)
- Parent application: `https://github.com/ckizer/couple-webcam`
- Parent submodule path: `vendor/vdo.ninja`

The `less-apart` branch carries the branded room surface, iframe bridge,
layout/media integration, Vercel configuration, and related assets. The parent
application pins an exact commit from this branch.

Do not merge or rebase upstream automatically. Fetch `upstream/develop`, review
the patch stack, run the parent repository's VDO, room, browser, and Tauri tests,
then push the tested result to `origin/less-apart` and update the parent
submodule pointer.
