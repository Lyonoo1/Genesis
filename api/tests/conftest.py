import os
import shutil
import tempfile
from pathlib import Path

# 在任何业务模块导入前强制隔离测试 SQLite 数据库路径，
# 杜绝 pytest 单测污染开发者或桌面端真实的 genesis.db。
_TEST_DB_DIR = Path(tempfile.mkdtemp(prefix="genesis_pytest_db_"))
_TEST_DB_PATH = _TEST_DB_DIR / "test_genesis.db"
os.environ["SQLITE_DB_PATH"] = str(_TEST_DB_PATH)
os.environ.setdefault("GENESIS_TEST_MODE", "1")

import pytest  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _cleanup_isolated_test_db():
    """测试会话结束后清理临时隔离数据库目录"""
    yield
    shutil.rmtree(_TEST_DB_DIR, ignore_errors=True)
