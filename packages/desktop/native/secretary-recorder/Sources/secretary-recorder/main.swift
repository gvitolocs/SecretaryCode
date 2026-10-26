import Foundation
import RecorderCore

#if os(macOS)
Host.run()
#else
// ScreenCaptureKit exists only on macOS. Other platforms build this target so RecorderCore's tests run.
print(encodeLine(Message.event("error", ["code": "unsupported", "message": "secretary-recorder requires macOS 13 or later", "fatal": true])))
exit(78)
#endif
