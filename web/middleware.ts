import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * 校验 JWT 签名 + 过期时间（Edge Runtime 兼容）
 * 使用 Supabase JWT Secret 进行 HMAC-SHA256 签名验证
 */
async function verifyJwt(token: string): Promise<boolean> {
  const secret = process.env.SUPABASE_JWT_SECRET;

  // 如果没配 JWT Secret，降级为结构 + 过期时间检查（开发环境）
  if (!secret) {
    return isJwtStructureValid(token);
  }

  try {
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
    });
    // 确保有 sub（用户 ID）
    return !!payload.sub;
  } catch {
    return false;
  }
}

/**
 * 降级检查：仅验证 JWT 结构和过期时间（无签名验证，仅用于未配置 JWT Secret 的开发环境）
 */
function isJwtStructureValid(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

    if (payload.exp && typeof payload.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now - 10) {
        return false;
      }
    }

    if (!payload.sub) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get("genesis_auth_token")?.value;

  // 1. 公开路径白名单：登录、静态资源直接放行
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/register");
  const isStaticAsset =
    pathname.startsWith("/_next") ||
    pathname.includes(".") ||
    pathname === "/favicon.ico";

  // 2. 企业级安全响应头 (防点击劫持、MIME 嗅探、XSS 注入)
  const applySecurityHeaders = (res: NextResponse) => {
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()"
    );
    return res;
  };

  // 静态资源直接放行（不加安全头，性能优先）
  if (isStaticAsset) {
    return NextResponse.next();
  }

  const isValidToken = token ? await verifyJwt(token) : false;

  // 3. 已登录用户访问 /login 或 /register 时，直接重定向回工作区主页
  if (isAuthRoute) {
    if (isValidToken) {
      return applySecurityHeaders(
        NextResponse.redirect(new URL("/", request.url))
      );
    }
    return applySecurityHeaders(NextResponse.next());
  }

  // 4. 受保护路由拦截：未登录或 Token 失效，强制重定向至 /login
  if (!isValidToken) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") {
      loginUrl.searchParams.set("redirect", pathname);
    }
    const response = NextResponse.redirect(loginUrl);
    // 清除可能残留的非法/过期 Cookie
    if (token) {
      response.cookies.delete("genesis_auth_token");
    }
    return applySecurityHeaders(response);
  }

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    /*
     * 匹配除 Next 内部资源外的所有请求
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
