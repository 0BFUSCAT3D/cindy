export type Locale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
const en = {
  protocol:'API protocol',engines:'Model engines',install:'Install',update:'Update',notInstalled:'Not installed',providerLogin:'Sign in to provider',you: 'You', tasks: 'Tasks', models: 'Models', connections: 'Connections', service: 'Service',
  local: 'This computer', emptyTasks: 'No tasks yet', newTask: 'New task', send: 'Send',
  back: 'Back', cancel: 'Cancel', save: 'Save', next: 'Next', quit: 'Detach',
  loading: 'Loading…', working: 'Working…', ready: 'Ready', offline: 'Disconnected',
  reconnect: 'Reconnect', refresh: 'Refresh', error: 'The operation could not be completed',
  noModel: 'Connect a model to start', addProvider: 'Add connection', providerName: 'Connection name',
  address: 'API address', apiKey: 'API key', modelId: 'Model ID', engine: 'Engine',
  defaultModel: 'Default model', choose: 'Select', test: 'Test connection', connected: 'Connected',
  login: 'Sign in to Cindy', sso: 'Enterprise SSO', email: 'Email', organization: 'Organization',
  code: 'Verification code', openBrowser: 'Open this link on your computer or phone',
  waitBrowser: 'Waiting for authorization…', signedOut: 'Not signed in', accounts: 'Accounts',
  signOut: 'Sign out', confirmRegion: 'Continue to the organization’s region?', yes: 'Continue', no: 'Cancel',
  bindEmail: 'Link your email', bindPhone: 'Link your phone', resend: 'Resend code',
  vaultSetup: 'Protect your credentials', machineKey: 'Unlock automatically on this computer',
  passphraseKey: 'Unlock with a passphrase after restart', passphrase: 'Passphrase (12+ characters)',
  unlock: 'Unlock', locked: 'Credentials locked', initialized: 'Configured',
  vaultExplanation: 'Automatic unlock uses a key protected by this system account.',
  remoteEnabled: 'Allow remote control', startAtBoot: 'Start at boot', installService: 'Install service', uninstallService: 'Remove startup registration', startsAtLogin: 'Starts at next login', startsAtBoot: 'Starts at next boot', deviceName: 'Computer name', language: 'Language',
  stopService: 'Stop background service', uptime: 'Uptime', version: 'Version',
  noDevices: 'No connected computers', device: 'Computer', connect: 'Connect',
  search: 'Search', commands: 'Commands', message: 'Message', history: 'History',
  stop: 'Stop', requests: 'Pending requests', approve: 'Allow', deny: 'Deny',
  noRequests: 'No pending requests', directory: 'Working directory', resources: 'Resources',
  selected: 'Selected', detail: 'Details', done: 'Done', required: 'This field is required',
  keyboard: 'Tab: section   ↑↓: select   Enter: open   Esc: back   Ctrl+Q: detach',
  inputKeys: 'Enter: send   Alt+Enter: new line   Esc: cancel',
  continueLocal: 'Use your own model', connectionLost: 'Connection lost. Reconnect to check the result.',
  refreshLogin: 'Sign in again', notImplemented: 'This capability is not available on this host.',
};
type Messages = typeof en;
const zhCN: Messages = {
  protocol:'API 协议',engines:'模型引擎',install:'安装',update:'更新',notInstalled:'未安装',providerLogin:'登录模型账号',you:'你',tasks:'任务',models:'模型',connections:'连接',service:'服务',local:'这台电脑',emptyTasks:'还没有任务',newTask:'新建任务',send:'发送',
  back:'返回',cancel:'取消',save:'保存',next:'下一步',quit:'退出界面',loading:'正在加载…',working:'正在处理…',ready:'就绪',offline:'已断开',
  reconnect:'重新连接',refresh:'刷新',error:'操作未完成',noModel:'连接模型后即可开始',addProvider:'添加连接',providerName:'连接名称',address:'API 地址',
  apiKey:'API 密钥',modelId:'模型 ID',engine:'引擎',defaultModel:'默认模型',choose:'选择',test:'测试连接',connected:'已连接',
  login:'登录 Cindy',sso:'企业 SSO',email:'邮箱',organization:'组织',code:'验证码',openBrowser:'在电脑或手机上打开此链接',waitBrowser:'等待授权…',
  signedOut:'未登录',accounts:'账号',signOut:'退出登录',confirmRegion:'前往组织所属区域继续登录？',yes:'继续',no:'取消',bindEmail:'绑定邮箱',bindPhone:'绑定手机',resend:'重新发送验证码',
  vaultSetup:'保护登录凭据',machineKey:'在这台电脑上自动解锁',passphraseKey:'重启后使用口令解锁',passphrase:'解锁口令（至少 12 个字符）',unlock:'解锁',locked:'凭据已锁定',initialized:'已配置',
  vaultExplanation:'自动解锁使用受当前系统账号保护的密钥。',remoteEnabled:'允许远程控制',startAtBoot:'开机启动',installService:'安装常驻服务',uninstallService:'移除启动项',startsAtLogin:'下次登录时启动',startsAtBoot:'下次开机时启动',deviceName:'电脑名称',language:'语言',stopService:'停止后台服务',uptime:'已运行',version:'版本',
  noDevices:'没有已连接的电脑',device:'电脑',connect:'连接',search:'搜索',commands:'命令',message:'消息',history:'对话记录',stop:'停止',requests:'待处理',approve:'允许',deny:'拒绝',
  noRequests:'没有待处理请求',directory:'工作目录',resources:'资源',selected:'已选择',detail:'详情',done:'完成',required:'请填写此项',
  keyboard:'Tab 切换页面   ↑↓ 选择   Enter 打开   Esc 返回   Ctrl+Q 退出界面',inputKeys:'Enter 发送   Alt+Enter 换行   Esc 取消',
  continueLocal:'使用自己的模型',connectionLost:'连接已断开，重新连接后查看执行结果。',refreshLogin:'重新登录',notImplemented:'这台电脑尚不具备此能力。',
};
const zhTW: Messages = {
  protocol:'API 協定',engines:'模型引擎',install:'安裝',update:'更新',notInstalled:'未安裝',providerLogin:'登入模型帳號',you:'你',tasks:'任務',models:'模型',connections:'連線',service:'服務',local:'這部電腦',emptyTasks:'還沒有任務',newTask:'新增任務',send:'傳送',
  back:'返回',cancel:'取消',save:'儲存',next:'下一步',quit:'退出介面',loading:'正在載入…',working:'正在處理…',ready:'就緒',offline:'已中斷',
  reconnect:'重新連線',refresh:'重新整理',error:'操作未完成',noModel:'連接模型後即可開始',addProvider:'新增連線',providerName:'連線名稱',address:'API 位址',
  apiKey:'API 金鑰',modelId:'模型 ID',engine:'引擎',defaultModel:'預設模型',choose:'選擇',test:'測試連線',connected:'已連線',
  login:'登入 Cindy',sso:'企業 SSO',email:'電子郵件',organization:'組織',code:'驗證碼',openBrowser:'在電腦或手機上開啟此連結',waitBrowser:'等待授權…',
  signedOut:'未登入',accounts:'帳號',signOut:'登出',confirmRegion:'前往組織所屬區域繼續登入？',yes:'繼續',no:'取消',bindEmail:'綁定電子郵件',bindPhone:'綁定手機',resend:'重新傳送驗證碼',
  vaultSetup:'保護登入憑證',machineKey:'在這部電腦上自動解鎖',passphraseKey:'重新啟動後使用密語解鎖',passphrase:'解鎖密語（至少 12 個字元）',unlock:'解鎖',locked:'憑證已鎖定',initialized:'已設定',
  vaultExplanation:'自動解鎖使用受目前系統帳號保護的金鑰。',remoteEnabled:'允許遠端控制',startAtBoot:'開機啟動',installService:'安裝常駐服務',uninstallService:'移除啟動項目',startsAtLogin:'下次登入時啟動',startsAtBoot:'下次開機時啟動',deviceName:'電腦名稱',language:'語言',stopService:'停止背景服務',uptime:'已執行',version:'版本',
  noDevices:'沒有已連線的電腦',device:'電腦',connect:'連線',search:'搜尋',commands:'命令',message:'訊息',history:'對話記錄',stop:'停止',requests:'待處理',approve:'允許',deny:'拒絕',
  noRequests:'沒有待處理請求',directory:'工作目錄',resources:'資源',selected:'已選擇',detail:'詳細資訊',done:'完成',required:'請填寫此項',
  keyboard:'Tab 切換頁面   ↑↓ 選擇   Enter 開啟   Esc 返回   Ctrl+Q 退出介面',inputKeys:'Enter 傳送   Alt+Enter 換行   Esc 取消',
  continueLocal:'使用自己的模型',connectionLost:'連線已中斷，重新連線後查看執行結果。',refreshLogin:'重新登入',notImplemented:'這部電腦尚不具備此能力。',
};
const ja: Messages = {
  protocol:'API プロトコル',engines:'モデルエンジン',install:'インストール',update:'更新',notInstalled:'未インストール',providerLogin:'プロバイダーにログイン',you:'あなた',tasks:'セッション',models:'モデル',connections:'接続',service:'サービス',local:'このコンピューター',emptyTasks:'セッションはありません',newTask:'新規セッション',send:'送信',
  back:'戻る',cancel:'キャンセル',save:'保存',next:'次へ',quit:'画面を閉じる',loading:'読み込み中…',working:'処理中…',ready:'準備完了',offline:'切断済み',
  reconnect:'再接続',refresh:'更新',error:'操作を完了できませんでした',noModel:'モデルを接続すると開始できます',addProvider:'接続を追加',providerName:'接続名',address:'API アドレス',
  apiKey:'API キー',modelId:'モデル ID',engine:'エンジン',defaultModel:'既定のモデル',choose:'選択',test:'接続をテスト',connected:'接続済み',
  login:'Cindy にログイン',sso:'企業 SSO',email:'メールアドレス',organization:'組織',code:'認証コード',openBrowser:'コンピューターまたはスマートフォンでリンクを開いてください',waitBrowser:'認証を待っています…',
  signedOut:'未ログイン',accounts:'アカウント',signOut:'ログアウト',confirmRegion:'組織のリージョンでログインを続けますか？',yes:'続ける',no:'キャンセル',bindEmail:'メールアドレスを連携',bindPhone:'電話番号を連携',resend:'コードを再送信',
  vaultSetup:'認証情報を保護',machineKey:'このコンピューターで自動解除',passphraseKey:'再起動後にパスフレーズで解除',passphrase:'パスフレーズ（12 文字以上）',unlock:'ロック解除',locked:'認証情報はロックされています',initialized:'設定済み',
  vaultExplanation:'自動解除には、このシステムアカウントで保護されたキーを使用します。',remoteEnabled:'リモート操作を許可',startAtBoot:'起動時に実行',installService:'常駐サービスをインストール',uninstallService:'自動起動を解除',startsAtLogin:'次回ログイン時に起動',startsAtBoot:'次回のシステム起動時に開始',deviceName:'コンピューター名',language:'言語',stopService:'バックグラウンドサービスを停止',uptime:'稼働時間',version:'バージョン',
  noDevices:'接続済みコンピューターはありません',device:'コンピューター',connect:'接続',search:'検索',commands:'コマンド',message:'メッセージ',history:'チャット履歴',stop:'停止',requests:'確認待ち',approve:'許可',deny:'拒否',
  noRequests:'確認待ちのリクエストはありません',directory:'作業ディレクトリ',resources:'リソース',selected:'選択済み',detail:'詳細',done:'完了',required:'入力してください',
  keyboard:'Tab: 画面切替   ↑↓: 選択   Enter: 開く   Esc: 戻る   Ctrl+Q: 閉じる',inputKeys:'Enter: 送信   Alt+Enter: 改行   Esc: キャンセル',
  continueLocal:'自分のモデルを使用',connectionLost:'接続が切れました。再接続して結果を確認してください。',refreshLogin:'再ログイン',notImplemented:'このホストでは利用できません。',
};
const ko: Messages = {
  protocol:'API 프로토콜',engines:'모델 엔진',install:'설치',update:'업데이트',notInstalled:'설치되지 않음',providerLogin:'공급자 로그인',you:'나',tasks:'세션',models:'모델',connections:'연결',service:'서비스',local:'이 컴퓨터',emptyTasks:'세션이 없습니다',newTask:'새 세션',send:'보내기',
  back:'뒤로',cancel:'취소',save:'저장',next:'다음',quit:'화면 닫기',loading:'불러오는 중…',working:'처리 중…',ready:'준비됨',offline:'연결 끊김',
  reconnect:'다시 연결',refresh:'새로 고침',error:'작업을 완료하지 못했습니다',noModel:'모델을 연결하면 시작할 수 있습니다',addProvider:'연결 추가',providerName:'연결 이름',address:'API 주소',
  apiKey:'API 키',modelId:'모델 ID',engine:'엔진',defaultModel:'기본 모델',choose:'선택',test:'연결 테스트',connected:'연결됨',
  login:'Cindy 로그인',sso:'기업 SSO',email:'이메일',organization:'조직',code:'인증 코드',openBrowser:'컴퓨터나 휴대폰에서 이 링크를 여세요',waitBrowser:'인증 대기 중…',
  signedOut:'로그인하지 않음',accounts:'계정',signOut:'로그아웃',confirmRegion:'조직의 리전에서 로그인을 계속할까요?',yes:'계속',no:'취소',bindEmail:'이메일 연결',bindPhone:'전화번호 연결',resend:'코드 다시 보내기',
  vaultSetup:'인증 정보 보호',machineKey:'이 컴퓨터에서 자동 잠금 해제',passphraseKey:'다시 시작한 후 암호로 잠금 해제',passphrase:'암호 (12자 이상)',unlock:'잠금 해제',locked:'인증 정보 잠김',initialized:'설정됨',
  vaultExplanation:'자동 잠금 해제는 현재 시스템 계정으로 보호되는 키를 사용합니다.',remoteEnabled:'원격 제어 허용',startAtBoot:'부팅 시 시작',installService:'상주 서비스 설치',uninstallService:'자동 시작 해제',startsAtLogin:'다음 로그인 시 시작',startsAtBoot:'다음 부팅 시 시작',deviceName:'컴퓨터 이름',language:'언어',stopService:'백그라운드 서비스 중지',uptime:'가동 시간',version:'버전',
  noDevices:'연결된 컴퓨터가 없습니다',device:'컴퓨터',connect:'연결',search:'검색',commands:'명령',message:'메시지',history:'채팅 기록',stop:'중지',requests:'대기 중인 요청',approve:'허용',deny:'거부',
  noRequests:'대기 중인 요청이 없습니다',directory:'작업 디렉터리',resources:'리소스',selected:'선택됨',detail:'상세 정보',done:'완료',required:'이 항목을 입력하세요',
  keyboard:'Tab: 화면 전환   ↑↓: 선택   Enter: 열기   Esc: 뒤로   Ctrl+Q: 닫기',inputKeys:'Enter: 보내기   Alt+Enter: 줄 바꿈   Esc: 취소',
  continueLocal:'내 모델 사용',connectionLost:'연결이 끊겼습니다. 다시 연결하여 결과를 확인하세요.',refreshLogin:'다시 로그인',notImplemented:'이 호스트에서는 사용할 수 없습니다.',
};
const messages: Record<Locale, Messages> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
export function getMessages(locale: Locale): Messages { return messages[locale]; }
export function resolveLocale(input = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en'): Locale {
  if (/^zh[_-](TW|HK|Hant)/i.test(input)) return 'zh-TW';
  if (/^zh/i.test(input)) return 'zh-CN';
  if (/^ja/i.test(input)) return 'ja';
  if (/^ko/i.test(input)) return 'ko';
  return 'en';
}
