# 长江下游流域降水事件产流分析软件 V1.0

本项目使用 TR-55 曲线数法估算流域事件产流，支持多流域计算、前期湿润条件设置、情景分析及结果导出。

## 本地运行

安装 Python 及依赖 `numpy`、`rasterio`、`netCDF4` 后运行 `python server.py`，访问 http://127.0.0.1:8765。可先使用页面内置示例。真实事件计算需要自行准备降水、土地利用、水文土组和 CN 参数。数据导入及索引逻辑见 `precipitation.py`、`database.py` 和 `import_tr55.py`。

运行 `node --test runoff.test.cjs` 验证产流计算。

## 云端源码

`cloud/` 包含网页、服务端和 NetCDF 处理源码。在该目录执行 `npm ci` 和 `node build.mjs` 构建。部署时需自行配置存储及数据。

本仓库发布软件源码。云端及本地研究数据、数据库、栅格、空间权重和部署配置单独管理。
