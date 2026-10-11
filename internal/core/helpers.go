package core

import (
	"runtime"
	"time"
)

func runtimeNumCPU() int { return runtime.NumCPU() }

// timeoutAfter 造一个「n 秒后触发」的 channel，给死锁类回归测试兜底。
func timeoutAfter(seconds int) <-chan time.Time {
	return time.After(time.Duration(seconds) * time.Second)
}
