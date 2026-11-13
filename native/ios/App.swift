// App iPhone៖ បើកកម្មវិធីបកប្រែ (https://hanumancafe.github.io/kh-cn/) ក្នុង WKWebView
// - មីក្រូហ្វូន៖ iPhone សួរតែម្តងសម្រាប់ App ហើយ App អនុញ្ញាតឲ្យទំព័រដោយខ្លួនឯង (មិនសួររាល់ពេលបើកដូច Safari)
// - កាមេរ៉ា / រូបថត៖ ម៉ឺនុយដើមរបស់ iPhone
// - កម្មវិធីយកកំណែថ្មីពី GitHub Pages ដោយខ្លួនឯង

import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    private static let home = URL(string: "https://hanumancafe.github.io/kh-cn/")!
    private static let host = "hanumancafe.github.io"
    private static let background = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 9 / 255, green: 11 / 255, blue: 20 / 255, alpha: 1)
            : UIColor(red: 236 / 255, green: 238 / 255, blue: 246 / 255, alpha: 1)
    }

    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "KHCNApp/1.5" // ទំព័រដឹងថាកំពុងនៅក្នុង App

        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = Self.background
        web.scrollView.backgroundColor = Self.background
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        webView = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: Self.home))
    }

    // ទំព័ររបស់យើងសុំមីក្រូហ្វូន → អនុញ្ញាតភ្លាម (iPhone សួរតែម្តងសម្រាប់ App ទាំងមូល)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == Self.host ? .grant : .deny)
    }

    // តំណដែលបើកផ្ទាំងថ្មី (ឧ. aistudio.google.com) → Safari
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // តំណទៅគេហទំព័រផ្សេង → Safari, ទំព័ររបស់យើង → នៅក្នុង App
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let scheme = url?.scheme?.lowercased() ?? ""
        let external = (scheme == "http" || scheme == "https") && url?.host != Self.host
        if let url = url, external, navigationAction.targetFrame?.isMainFrame == true {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let offline: Set<Int> = [
            NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
            NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed,
            NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed,
        ]
        let err = error as NSError
        if err.domain == NSURLErrorDomain && offline.contains(err.code) { showOffline() }
    }

    // iPhone បិទដំណើរការទំព័រ (ពេលអង្គចងចាំតិច) → បើកឡើងវិញ
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: Self.home))
    }

    private func showOffline() {
        let html = """
        <!doctype html><html lang="km"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;height:100vh;display:grid;place-items:center;font-family:-apple-system,sans-serif;
        background:#ECEEF6;color:#14182B;text-align:center}
        @media(prefers-color-scheme:dark){body{background:#090B14;color:#EEF0FA}}
        button{margin-top:18px;padding:14px 26px;border:0;border-radius:16px;background:#3A47D5;color:#fff;font-size:17px}</style>
        <div><div style="font-size:46px">📶</div>
        <p style="font-size:19px;font-weight:600">គ្មានអ៊ីនធឺណិត</p>
        <p style="opacity:.7">ការបកប្រែត្រូវការអ៊ីនធឺណិត។</p>
        <button onclick="location.href='\(Self.home.absoluteString)'">សាកម្តងទៀត</button></div></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}
