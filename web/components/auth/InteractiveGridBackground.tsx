"use client";

import React, { useEffect, useRef } from "react";

interface FluidNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function InteractiveGridBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = 0;
    let height = 0;
    let dpr = 1;

    // 1. 多节阻尼流体尾迹（重流体 / 黏性流体模型）
    // 鼠标在最前端，后面链接 14 个带质量和强阻尼的流体节点
    const TRAIL_LENGTH = 14;
    const trail: FluidNode[] = [];
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      trail.push({ x: -9999, y: -9999, vx: 0, vy: 0 });
    }

    const mouse = {
      x: -9999,
      y: -9999,
      active: false,
    };

    // 2. 静态精密微网格 (无任何爆裂、无闪烁点、绝无烟花感)
    const spacing = 32;
    let cols = 0;
    let rows = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.scale(dpr, dpr);

      cols = Math.ceil(width / spacing) + 1;
      rows = Math.ceil(height / spacing) + 1;
    };

    resize();
    window.addEventListener("resize", resize);

    const onMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;

      // 初次进入初始化位置
      if (trail[0].x === -9999) {
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          trail[i].x = mouse.x;
          trail[i].y = mouse.y;
        }
      }
    };

    const onMouseLeave = () => {
      mouse.active = false;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseleave", onMouseLeave);

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // 深邃纯黑底色
      ctx.fillStyle = "#090A0F";
      ctx.fillRect(0, 0, width, height);

      // 3. 高阻尼流体动力学计算 (Viscous Fluid Damping)
      if (mouse.active && trail[0].x !== -9999) {
        // 头节点向鼠标强阻尼缓动 (重流体质感：低响应比 + 慢收敛)
        const headSpring = 0.065;
        trail[0].vx = (mouse.x - trail[0].x) * headSpring;
        trail[0].vy = (mouse.y - trail[0].y) * headSpring;
        trail[0].x += trail[0].vx;
        trail[0].y += trail[0].vy;

        // 后续节点级联滞后跟随，形成一条极具重量感的流体水流拖尾
        for (let i = 1; i < TRAIL_LENGTH; i++) {
          const prev = trail[i - 1];
          const curr = trail[i];
          const dampingRatio = 0.08 * (1 - i / (TRAIL_LENGTH * 1.4));

          curr.vx = (prev.x - curr.x) * dampingRatio;
          curr.vy = (prev.y - curr.y) * dampingRatio;
          curr.x += curr.vx;
          curr.y += curr.vy;
        }

        // 4. 绘制黏性水流的柔和连续光晕（无闪烁、无烟花，仅有深沉流体暗光）
        for (let i = TRAIL_LENGTH - 1; i >= 0; i -= 2) {
          const node = trail[i];
          const radius = 140 * (1 - (i / TRAIL_LENGTH) * 0.4);
          const alpha = 0.08 * (1 - i / TRAIL_LENGTH);

          const grad = ctx.createRadialGradient(
            node.x,
            node.y,
            0,
            node.x,
            node.y,
            radius
          );
          grad.addColorStop(0, `rgba(99, 102, 241, ${alpha * 1.5})`);
          grad.addColorStop(0.5, `rgba(56, 189, 248, ${alpha * 0.6})`);
          grad.addColorStop(1, "transparent");

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 5. 渲染被黏性流体扰动的网格点（物理透镜柔和推挤，绝不刺眼）
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const origX = c * spacing;
          const origY = r * spacing;

          let totalDispX = 0;
          let totalDispY = 0;
          let maxProximity = 0;

          // 遍历流体骨架节点计算流体透镜位移
          if (mouse.active && trail[0].x !== -9999) {
            for (let i = 0; i < TRAIL_LENGTH; i += 3) {
              const node = trail[i];
              const dx = origX - node.x;
              const dy = origY - node.y;
              const dist = Math.hypot(dx, dy);
              const influenceRadius = 130;

              if (dist < influenceRadius && dist > 0) {
                const factor = 1 - dist / influenceRadius;
                // 平滑的高斯下凹推挤
                const push = Math.sin(factor * Math.PI) * 7.5;
                totalDispX += (dx / dist) * push;
                totalDispY += (dy / dist) * push;
                maxProximity = Math.max(maxProximity, factor);
              }
            }
          }

          const renderX = origX + totalDispX;
          const renderY = origY + totalDispY;

          // 保持完全平稳克制的点阵颜色：平静时 0.07 透明，受水流扰动时平滑增至 0.28
          const alpha = 0.07 + maxProximity * 0.22;
          ctx.beginPath();
          ctx.arc(renderX, renderY, 1.1, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.fill();
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(animationFrameId);
      } else {
        animationFrameId = requestAnimationFrame(render);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    animationFrameId = requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-0"
    />
  );
}
