import json
from typing import Any
from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
from core.sqlite_db import get_db_connection

router = APIRouter(tags=["Database Viewer"])


class QueryRequest(BaseModel):
    sql: str


@router.get("/api/db/tables", summary="获取数据库所有表信息与统计")
async def get_tables_info():
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
        tables = [row["name"] for row in cursor.fetchall()]

        result = []
        for tbl in tables:
            cursor.execute(f"SELECT COUNT(*) as cnt FROM {tbl}")
            count = cursor.fetchone()["cnt"]

            cursor.execute(f"PRAGMA table_info({tbl});")
            columns = [
                {"name": col["name"], "type": col["type"], "pk": bool(col["pk"])}
                for col in cursor.fetchall()
            ]

            result.append({
                "table": tbl,
                "count": count,
                "columns": columns,
            })
        return {"tables": result}


@router.get("/api/db/table-data/{table_name}", summary="获取单表数据")
async def get_table_data(
    table_name: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # 校验表名合法性防止 SQL 注入
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?;", (table_name,))
        if not cursor.fetchone():
            return JSONResponse(status_code=404, content={"error": f"Table '{table_name}' not found"})

        cursor.execute(f"PRAGMA table_info({table_name});")
        columns = [col["name"] for col in cursor.fetchall()]

        cursor.execute(f"SELECT * FROM {table_name} LIMIT ? OFFSET ?;", (limit, offset))
        rows = [dict(r) for r in cursor.fetchall()]

        cursor.execute(f"SELECT COUNT(*) as total FROM {table_name};")
        total = cursor.fetchone()["total"]

        return {
            "table": table_name,
            "columns": columns,
            "rows": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        }


@router.post("/api/db/execute-sql", summary="执行 SQL 查询")
async def execute_custom_sql(req: QueryRequest):
    sql = req.sql.strip()
    if not sql:
        return {"error": "SQL 语句不能为空"}

    with get_db_connection() as conn:
        cursor = conn.cursor()
        try:
            cursor.execute(sql)
            if sql.upper().startswith("SELECT") or sql.upper().startswith("PRAGMA"):
                rows = [dict(r) for r in cursor.fetchall()]
                columns = [desc[0] for desc in cursor.description] if cursor.description else []
                return {"success": True, "columns": columns, "rows": rows, "count": len(rows)}
            else:
                conn.commit()
                return {"success": True, "affected_rows": cursor.rowcount, "message": "SQL 执行成功"}
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": str(e)})


@router.get("/db", response_class=HTMLResponse, summary="Web 可视化数据库管理看板")
async def db_viewer_page():
    html_content = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Genesis 数据库可视化面板 (genesis.db)</title>
  <style>
    :root {
      --bg: #121214;
      --sidebar: #18181b;
      --card: #1f1f23;
      --border: #2e2e33;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --danger: #ef4444;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
      font-size: 13px;
    }
    /* 侧边栏 */
    aside {
      width: 250px;
      background: var(--sidebar);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header h1 {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .table-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      list-style: none;
    }
    .table-item {
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--muted);
      margin-bottom: 4px;
      transition: all 0.15s;
    }
    .table-item:hover {
      background: var(--card);
      color: var(--text);
    }
    .table-item.active {
      background: var(--card);
      color: #fff;
      font-weight: 600;
      border-left: 3px solid var(--accent);
    }
    .count-badge {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
    }
    /* 主视口 */
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      padding: 12px 20px;
      background: var(--sidebar);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title-area {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .table-title {
      font-size: 16px;
      font-weight: 600;
    }
    .btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: 0.15s;
    }
    .btn:hover {
      background: var(--border);
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    /* SQL 控制台 */
    .sql-box {
      padding: 12px 20px;
      background: #141416;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .sql-input {
      flex: 1;
      height: 54px;
      background: #0d0d0f;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #38bdf8;
      font-family: monospace;
      padding: 8px 12px;
      font-size: 13px;
      resize: vertical;
    }
    .sql-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    /* 数据表格区域 */
    .content-area {
      flex: 1;
      overflow: auto;
      padding: 0;
      position: relative;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      position: sticky;
      top: 0;
      background: #1b1b1f;
      color: var(--muted);
      padding: 10px 14px;
      font-weight: 600;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      z-index: 10;
    }
    td {
      padding: 9px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
      word-break: break-all;
      max-width: 480px;
      font-family: inherit;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .json-cell {
      font-family: monospace;
      font-size: 11px;
      color: #34d399;
      background: rgba(0, 0, 0, 0.2);
      padding: 4px 6px;
      border-radius: 4px;
      max-height: 80px;
      overflow-y: auto;
    }
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <aside>
    <div class="header">
      <h1>🗄️ Genesis DB</h1>
      <span class="badge">SQLite 在线</span>
    </div>
    <div style="padding: 10px 16px 4px 16px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">
      物理数据表
    </div>
    <ul class="table-list" id="tableList">
      <li style="padding: 12px; color: var(--muted);">加载表列表中...</li>
    </ul>
    <div style="padding: 12px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted);">
      物理路径: <span style="color:#e4e4e7">genesis.db</span>
    </div>
  </aside>

  <main>
    <div class="toolbar">
      <div class="title-area">
        <span class="table-title" id="currentTableName">选择一个表查看</span>
        <span class="badge" id="rowCountBadge" style="display:none;">0 行记录</span>
      </div>
      <div>
        <button class="btn" onclick="refreshCurrentTable()">🔄 刷新当前数据</button>
      </div>
    </div>

    <div class="sql-box">
      <textarea class="sql-input" id="sqlQuery" placeholder="输入任意自定义 SQL，按快捷键 Ctrl+Enter 或点击右侧执行 (例如: SELECT * FROM messages ORDER BY created_at DESC;)"></textarea>
      <button class="btn btn-primary" style="height: 54px; padding: 0 16px;" onclick="runCustomSql()">⚡ 执行 SQL</button>
    </div>

    <div class="content-area" id="contentArea">
      <div class="empty-state">
        <p>请在左侧选择要查看的表，或在上方运行 SQL 查询</p>
      </div>
    </div>
  </main>

  <script>
    let currentTable = null;

    async function loadTables() {
      try {
        const res = await fetch('/api/db/tables');
        const data = await res.json();
        const listEl = document.getElementById('tableList');
        listEl.innerHTML = '';

        if (!data.tables || data.tables.length === 0) {
          listEl.innerHTML = '<li style="padding: 12px; color: var(--muted);">未检测到表</li>';
          return;
        }

        data.tables.forEach((tbl, idx) => {
          const li = document.createElement('li');
          li.className = 'table-item' + (idx === 0 && !currentTable ? ' active' : '');
          li.innerHTML = `
            <span>📄 ${tbl.table}</span>
            <span class="count-badge">${tbl.count}</span>
          `;
          li.onclick = () => {
            document.querySelectorAll('.table-item').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            selectTable(tbl.table);
          };
          listEl.appendChild(li);
        });

        if (!currentTable && data.tables.length > 0) {
          selectTable(data.tables[0].table);
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function selectTable(tableName) {
      currentTable = tableName;
      document.getElementById('currentTableName').innerText = tableName;
      document.getElementById('sqlQuery').value = `SELECT * FROM ${tableName} ORDER BY rowid DESC LIMIT 100;`;
      await fetchTableData(tableName);
    }

    async function fetchTableData(tableName) {
      const container = document.getElementById('contentArea');
      container.innerHTML = '<div style="padding: 20px; color: var(--muted);">正在加载数据...</div>';

      try {
        const res = await fetch(`/api/db/table-data/${tableName}?limit=100`);
        const data = await res.json();

        if (data.error) {
          container.innerHTML = `<div style="padding: 20px; color: var(--danger);">${data.error}</div>`;
          return;
        }

        const badge = document.getElementById('rowCountBadge');
        badge.style.display = 'inline-block';
        badge.innerText = `${data.total} 行记录`;

        renderGrid(data.columns, data.rows);
      } catch (err) {
        container.innerHTML = `<div style="padding: 20px; color: var(--danger);">${err.message}</div>`;
      }
    }

    function renderGrid(columns, rows) {
      const container = document.getElementById('contentArea');
      if (!rows || rows.length === 0) {
        container.innerHTML = '<div class="empty-state">当前表中暂无数据记录</div>';
        return;
      }

      let html = '<table><thead><tr>';
      columns.forEach(col => {
        html += `<th>${col}</th>`;
      });
      html += '</tr></thead><tbody>';

      rows.forEach(row => {
        html += '<tr>';
        columns.forEach(col => {
          let val = row[col];
          if (val === null || val === undefined) {
            html += '<td style="color: #71717a; font-style: italic;">NULL</td>';
          } else if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
            try {
              const formatted = JSON.stringify(JSON.parse(val), null, 2);
              html += `<td><div class="json-cell">${escapeHtml(formatted)}</div></td>`;
            } catch {
              html += `<td>${escapeHtml(String(val))}</td>`;
            }
          } else {
            html += `<td>${escapeHtml(String(val))}</td>`;
          }
        });
        html += '</tr>';
      });

      html += '</tbody></table>';
      container.innerHTML = html;
    }

    async function runCustomSql() {
      const sql = document.getElementById('sqlQuery').value.trim();
      if (!sql) return;

      const container = document.getElementById('contentArea');
      container.innerHTML = '<div style="padding: 20px; color: var(--muted);">执行中...</div>';

      try {
        const res = await fetch('/api/db/execute-sql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql })
        });
        const data = await res.json();

        if (data.error) {
          container.innerHTML = `<div style="padding: 20px; color: var(--danger);">SQL 执行失败: ${data.error}</div>`;
          return;
        }

        if (data.rows) {
          const badge = document.getElementById('rowCountBadge');
          badge.style.display = 'inline-block';
          badge.innerText = `查询到 ${data.count} 条记录`;
          renderGrid(data.columns, data.rows);
        } else {
          container.innerHTML = `<div style="padding: 20px; color: var(--success);">${data.message || '执行成功，受影响行数: ' + data.affected_rows}</div>`;
          loadTables();
        }
      } catch (err) {
        container.innerHTML = `<div style="padding: 20px; color: var(--danger);">${err.message}</div>`;
      }
    }

    function refreshCurrentTable() {
      if (currentTable) {
        fetchTableData(currentTable);
        loadTables();
      }
    }

    function escapeHtml(str) {
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    document.getElementById('sqlQuery').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runCustomSql();
      }
    });

    loadTables();
  </script>
</body>
</html>
"""
    return HTMLResponse(content=html_content)
