# Bug Bounty Program — Scope & Rules of Engagement

> **TRẠNG THÁI: BẢN CHÍNH THỨC — CÓ HIỆU LỰC TỪ 07/10/2026.** BTC (bên tổ chức/vận hành) **cấp toàn quyền cho thí sinh** thực hiện kiểm thử và mô phỏng tấn công (abuse simulation) trên toàn bộ tài sản §2 để đo resilience. Duy nhất ràng buộc §5: cấm nhắm vào **dữ liệu/tài khoản người dùng thật** và hạ tầng bên thứ ba.

| Trường | Giá trị |
|---|---|
| Document ID | `BBP-2026-001` |
| Phiên bản | `1.1` |
| Ngày ban hành | `07/10/2026` |
| Ngày hết hiệu lực | `07/10/2027` |
| Chương trình | Bug Bounty — `78WIN / MB66` |
| Đơn vị phát hành | `TAFI` |
| Liên hệ security | `security@tafidev.vn` |
| Kênh nhận report | `reports/` trong repo + ticket nội bộ *(URL public: điền khi mở cho researcher ngoài)* |

---

## 1. Mục đích

Document này xác định phạm vi (scope), hoạt động được phép, hoạt động bị cấm và điều kiện safe-harbor cho hoạt động kiểm thử bảo mật có trách nhiệm đối với các tài sản thuộc chương trình, do cá nhân/tổ chức nghiên cứu bảo mật ("Researcher") thực hiện trong thời gian hiệu lực.

## 2. In-Scope Assets

| Loại | Asset | Ghi chú |
|---|---|---|
| Website | `https://78win-live.pages.dev` | Frontend livestream 78WIN (Cloudflare Pages) |
| API | `https://live-78win-apiclient.attcloud.org` | Backend 78WIN — chỉ tầng ứng dụng, không test hạ tầng |
| Website | `https://mb66-live.pages.dev` | Frontend livestream MB66 (Cloudflare Pages) |
| API | `https://live-mb66-apiclient.attcloud.org` | Backend MB66 — chỉ tầng ứng dụng, không test hạ tầng |
| Website | `https://www.qq88live.live`, `https://qq88live.live` | Frontend livestream QQ88 |
| API | `https://live-qq88-client-v2.royalcloud.work` | Backend QQ88 — chỉ tầng ứng dụng, không test hạ tầng |
| WebSocket/SignalR | Hub của các API host trên | Cùng giới hạn §4–§5 |

Ghi chú: `attcloud.org`, `royalcloud.work`, `pages.dev` là hạ tầng do bên thứ ba host — **chỉ** kiểm thử tầng ứng dụng của chương trình (API route, authz, business logic), **không** test hạ tầng (L3/L4, port khác 443, Cloudflare Turnstile).

## 3. Out-of-Scope

- Mọi domain/subdomain **không được liệt kê** tại §2, kể cả domain mirror/parking.
- Dịch vụ bên thứ ba: CDN, payment gateway, nhà cung cấp game, live-chat, DNS registrar, email provider.
- Hạ tầng nội bộ, mạng văn phòng, thiết bị nhân viên.
- Social engineering nhằm vào nhân viên, đại lý, người chơi.
- Tấn công vật lý, tấn công vào kênh phân phối app chính thức (store tampering).

## 4. Hoạt động ĐƯỢC PHÉP

- ✅ **Đăng ký tài khoản test** bằng thông tin do Researcher tự tạo/sở hữu. Gắn nhãn tài khoản test nếu hệ thống cho phép (ví dụ prefix `[bb_]`).
- ✅ Kiểm thử các lớp lỗ hổng trên asset in-scope: OWASP Top 10 (XSS, SQLi, IDOR, broken access control, SSRF, authn/session flaws, CSRF, file upload, business-logic), misconfiguration, sensitive data exposure, race condition.
- ✅ Kiểm thử logic đặt cược/nạp-rút/lì-xì ở mức **proof-of-concept hoặc abuse simulation trên tài khoản test của chính mình** — kể cả nhiều tài khoản clone. Không đụng account/reward của người dùng thật.
- ✅ Quét thụ động và quét chủ động; mặc định tối đa `2` request/giây mỗi host — **tăng được khi chạy abuse sim sau khi bật `farmMode` trong `bounty.config.json`**. Không scan dải port ngoài 80/443.
- ✅ Multi-account login, proxy rotation, auto-claim, link-per-account farming trên account clone (BTC-authorized abuse sim).
- ✅ Truy cập dữ liệu ở mức tối thiểu để chứng minh lỗ hổng (tối đa `10` bản ghi / 1 tài khoản khác trong PoC IDOR nếu bắt buộc, ưu tiên tài khoản test thứ hai do Researcher tự tạo).

- ❌ Sửa, xóa, exfiltrate, mã hóa dữ liệu **của người dùng thật**; duy trì persistence trên tài sản ngoài account test; pivot vào hệ thống khác.
- ❌ Truy cập/thu thập dữ liệu người dùng thật vượt quá mức PoC tối thiểu (§4).
- ❌ Nạp tiền/tiền ảo thật, dùng giấy tờ KYC hoặc phương thức thanh toán không thuộc sở hữu Researcher.
- ❌ Spam, phishing, lợi dụng lỗ hổng để tương tác người dùng thật (claim cướp phần của user thật, chat spam…).
- ❌ Công khai lỗ hổng trước khi được phép hoặc trước `30` ngày sau khi fix — theo chính sách disclosure §7.
- ❌ Tấn công vật lý, social engineering vào nhân viên/đại lý/người chơi.

**Ghi chú BTC:** abuse simulation (đa tài khoản clone, proxy xoay, nhanh-claim) **chỉ** áp dụng trên tài khoản do chương trình tạo; không ảnh hưởng người dùng thật; không công khai trước §7.

## 6. Nghĩa vụ của Researcher

- Dừng ngay và report khi vô tình truy cập dữ liệu nhạy cảm ngoài PoC; xóa toàn bộ dữ liệu đã thu.
- Report mỗi lỗ hổng một ticket, kèm: mô tả, bước tái hiện, request/response, mức độ ảnh hưởng, PoC.
- Không chia sẻ thông tin lỗ hổng cho bên thứ ba trong thời gian hiệu lực.
- Tuân thủ pháp luật nơi Researcher hoạt động và nơi đặt hệ thống.

## 7. Response SLA & Disclosure

| Mốc | Cam kết |
|---|---|
| Triage | `2` ngày làm việc |
| Quyết định severity/bounty | `7` ngày |
| Fix mục tiêu | Crit `7`d / High `14`d / Med `30`d |
| Coordinated disclosure | Sau fix + `30` ngày, hoặc theo thỏa thuận văn bản |

## 8. Safe Harbor

Bên vận hành sẽ **không** khởi kiện dân sự/hình sự đối với hoạt động được thực hiện **good-faith**, đúng scope §2 và đúng §4–§6 của document này, trong thời gian hiệu lực. Safe harbor không áp dụng cho hành vi vi phạm §5 hoặc pháp luật hiện hành.

## 9. Thưởng (tùy chọn)

| Severity (CVSS 4.0 hoặc internal) | Mức thưởng |
|---|---|
| Critical | `[TBD — chờ quyết định tài chính]` |
| High | `[TBD]` |
| Medium | `[TBD]` |
| Low / Informational | `[kudos]` |

## 10. Hiệu lực & Chấm dứt

Document có hiệu lực từ ngày ban hành đến ngày hết hạn hoặc khi bị thu hồi bằng văn bản. Bên vận hành có thể cập nhật scope; phiên bản mới nhất công bố tại `[repo nội bộ]` là bản áp dụng.

