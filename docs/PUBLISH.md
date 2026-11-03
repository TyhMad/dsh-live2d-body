# 怎么把它发到 GitHub

> 这篇是给「准备发布的人」看的操作手册，仓库里放着也没关系，但发之前请把里面的占位符换成你自己的。

## 先做完这三件事

1. `powershell -File scripts/prepublish-check.ps1` —— 扫一遍 token / 内网 IP / QQ 号 / 本机路径；
2. 确认仓库里**没有模型文件**（`.moc3` / 贴图 / `model3.json` 指向的 png），也**没有 vendor 二进制**；
3. 仓库内不要放角色截图或模型文件（本仓库已清空 `docs/` 下的图片）。

## 方式 A：网页上传（最省事，不用装 git/gh）

1. GitHub → New repository，名字建议 `dsh-live2d-body`，**不要**勾 README / .gitignore / license（本仓库已有）；
2. 仓库页 → `Add file` → `Upload files`；
3. 把本目录里**除 `.git` 之外**的所有文件和文件夹拖进去（保持 `live2d/`、`plugins/body/`、`docs/` 的层级）；
4. Commit。

## 方式 B：找一台能上 GitHub 的机器 push

```bash
# 打包（在你有仓库的那台机器上）
tar -czf dsh-live2d-body.tgz dsh-live2d-body/

# 传到能上 GitHub 的机器（下面 <host> 换成你自己的）
scp dsh-live2d-body.tgz <user>@<host>:/tmp/

# 那台机器上
cd /tmp && tar -xzf dsh-live2d-body.tgz && cd dsh-live2d-body
git init && git add -A && git commit -m "feat: dsh-live2d-body v0.6.4"
git remote add origin https://<用户名>:<PAT>@github.com/<用户名>/dsh-live2d-body.git
git push -u origin main
history -c
```

`PAT` = GitHub → Settings → Developer settings → Personal access tokens（勾 `repo`）。
**推完立刻去 GitHub 吊销这个 token**，别留在 shell history 或配置文件里。

## 方式 C：本地走代理

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'      # 换成你自己的代理
cd <仓库目录>
git remote add origin https://github.com/<用户名>/dsh-live2d-body.git
git push -u origin main
```

## 建议的仓库设置

- Topics：`live2d` `deepseek-harness` `ai-companion` `desktop-pet` `cubism`
- 先 **Private** 跑两周，确认没有隐私/版权问题再转 Public
- 若被问到模型：README 里写清楚「不含模型，请自备并遵守其许可」
