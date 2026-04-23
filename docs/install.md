# Ymcp 安装与更新

## 安装

```powershell
pip install ymcp
```

## 更新

```powershell
pip install -U ymcp
```

## 本地开发安装

```powershell
python -m pip install -e .[dev]
```

## 安装后检查

```powershell
ymcp doctor
ymcp --version
ymcp inspect-tools --json
```

Trae 用户可继续运行：

```powershell
ymcp print-config --host trae
ymcp init-trae
```
