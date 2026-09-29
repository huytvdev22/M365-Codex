# syntax=docker/dockerfile:1
#
# Image vận hành M365-Codex.
# Tiến trình đơn, container đơn: Cổng 8080, thư mục dữ liệu /data, chạy dưới quyền non-root, hỗ trợ thoát nhẹ nhàng (graceful exit) với SIGTERM.
# Trong image không chứa phụ thuộc phát triển, tệp tài khoản, .env hay bất kỳ Token nào.

# ---------- Giai đoạn xây dựng (Builder) ----------
FROM node:24-alpine AS builder
WORKDIR /app

# Chỉ sao chép các tệp manifest trước để tối đa hóa bộ nhớ cache của các layer
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
# Chỉ xây dựng server: script build ở root sẽ xây dựng cả frontend, trong khi tại bước này apps/web chưa được COPY vào
RUN npm run build:server

# Giao diện quản trị cài đặt phụ thuộc riêng và xây dựng độc lập. Nó không nằm trong workspace gốc, dùng lockfile riêng —
# Cây phụ thuộc frontend (React/Vite) hoàn toàn độc lập với server, gộp chung vào cùng một lockfile chỉ gây
# ràng buộc lẫn nhau. Việc tách riêng giúp layer cache của image khi "chỉ sửa frontend" không bị gián đoạn bởi các thay đổi từ phía server.
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN npm ci --prefix apps/web
COPY apps/web apps/web
RUN npm run build --prefix apps/web

# Chỉ giữ lại các phụ thuộc production
RUN npm prune --omit=dev

# Các phụ thuộc workspace không phải lúc nào cũng được nâng lên node_modules ở thư mục gốc: khi thư mục gốc bị chiếm bởi một phiên bản nào đó
# (ví dụ ajv@6 phụ thuộc bởi eslint), phiên bản thực tế cần dùng sẽ nằm dưới apps/server/node_modules.
# Giai đoạn runtime bắt buộc phải bao gồm cả tầng này, nếu không container khởi động sẽ gặp lỗi ERR_MODULE_NOT_FOUND.
# Tạo sẵn thư mục trống trước để đảm bảo lệnh COPY bên dưới không bị lỗi khi toàn bộ phụ thuộc đều được đưa lên root.
RUN mkdir -p apps/server/node_modules packages/shared/node_modules

# ---------- Giai đoạn vận hành (Runtime) ----------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# tini chịu trách nhiệm chuyển tiếp tín hiệu và thu dọn các tiến trình zombie
RUN apk add --no-cache tini

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
# Giao diện quản trị chỉ cần sản phẩm xây dựng (dist), không bao gồm node_modules của frontend
COPY --from=builder /app/apps/web/dist ./apps/web/dist
# Danh mục mô hình: được đọc tại runtime bởi responses/models.ts. Nếu bỏ quên bản sao chép này, hệ thống sẽ âm thầm giáng cấp
# về danh mục tích hợp sẵn chỉ chứa 1 mô hình — môi trường thực tế từng chỉ trả về 1 mô hình trong khi cấu hình có 3 mô hình.
COPY config ./config

# Image node có sẵn user node với uid/gid 1000; thư mục dữ liệu cần được phân quyền cho user này sở hữu
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/server.js"]
