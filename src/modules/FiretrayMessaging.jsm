/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "firetray", "FLDRS_UNINTERESTING" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource:///modules/mailServices.js");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/PluralForm.jsm");
Cu.import("resource://firetray/commons.js");

const FLDRS_UNINTERESTING = {
  Archive:   Ci.nsMsgFolderFlags.Archive,
  Drafts:    Ci.nsMsgFolderFlags.Drafts,
  Junk:      Ci.nsMsgFolderFlags.Junk,
  Queue:     Ci.nsMsgFolderFlags.Queue,
  SentMail:  Ci.nsMsgFolderFlags.SentMail,
  Templates: Ci.nsMsgFolderFlags.Templates,
  Trash:     Ci.nsMsgFolderFlags.Trash,
  Virtual:   Ci.nsMsgFolderFlags.Virtual
};

let log = firetray.Logging.getLogger("firetray.Messaging");


firetray.Messaging = {
  initialized: false,
  currentMsgCount: null,
  newMsgCount: null,
  observedTopics: {},

  init: function() {
    if (this.initialized) {
      log.warn("Messaging already initialized");
      return;
    }
    log.debug("Enabling Messaging");

    firetray.Utils.addObservers(firetray.Messaging, ["account-removed"]);

    let that = this;
    MailServices.mailSession.AddFolderListener(that.mailSessionListener,
                                               that.mailSessionListener.notificationFlags);

    this.initialized = true;
  },

  shutdown: function() {
    if (!this.initialized) return;
    log.debug("Disabling Messaging");

    MailServices.mailSession.RemoveFolderListener(this.mailSessionListener);

    firetray.Utils.removeAllObservers(firetray.Messaging);

    this.initialized = false;
  },

  observe: function(subject, topic, data) {
    log.debug("RECEIVED Messaging: "+topic+" subject="+subject+" data="+data);
    switch (topic) {
    case "account-removed":
      this.cleanExcludedAccounts();
      break;
    default:
      log.warn("unhandled topic: "+topic);
    }
  },

  /* removes removed accounts from excludedAccounts pref. NOTE: Can't be called
    at shutdown because MailServices.accounts no longer available */
  cleanExcludedAccounts: function() {
    log.debug("* cleaning *");
    let mailAccounts = firetray.Utils.getObjPref('mail_accounts');
    let excludedAccounts = mailAccounts["excludedAccounts"];

    // build current list of account server keys
    let accounts = MailServices.accounts.accounts;
    let accountServerKeys = [];
    for (let i=0, len=accounts.Count(); i<len; ++i) {
      let account = accounts.QueryElementAt(i, Ci.nsIMsgAccount);
      accountServerKeys[i] = account.incomingServer.key;
    }

    let newExcludedAccounts = [], cleaningNeeded = 0;
    for (let i=0, len=excludedAccounts.length; i<len; ++i) {
      let excludedAccount = excludedAccounts[i];
      if (accountServerKeys.indexOf(excludedAccount) >= 0)
        newExcludedAccounts.push(excludedAccount);
      else
        cleaningNeeded += 1;
    }

    if (cleaningNeeded) {
      log.debug("cleaning excluded accounts");
      let prefObj = {"serverTypes":mailAccounts["serverTypes"], "excludedAccounts":newExcludedAccounts};
      firetray.Utils.setObjPref('mail_accounts', prefObj);
    }
  },

  // https://bugzilla.mozilla.org/show_bug.cgi?id=715799 for TB15+
  // mozINewMailNotificationService (alternative message counting)
  /* http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIFolderListener.idl */
  mailSessionListener: {
    notificationFlags:
      // Ci.nsIFolderListener.propertyChanged |
      Ci.nsIFolderListener.propertyFlagChanged |
      // Ci.nsIFolderListener.event |
      Ci.nsIFolderListener.boolPropertyChanged |
      Ci.nsIFolderListener.intPropertyChanged,

    OnItemPropertyChanged: function(item, property, oldValue, newValue) { // NumNewBiffMessages
      log.debug("OnItemPropertyChanged "+property+" for folder "+item.prettyName+" was "+oldValue+" became "+newValue+" NEW MESSAGES="+item.getNumNewMessages(true));
    },

    OnItemIntPropertyChanged: function(item, property, oldValue, newValue) { // TotalUnreadMessages, BiffState (per server)
      log.debug("OnItemIntPropertyChanged "+property+" for folder "+item.prettyName+" was "+oldValue+" became "+newValue+" NEW MESSAGES="+item.getNumNewMessages(true));
      this.onMsgCountChange(item, property, oldValue, newValue);
    },

    OnItemBoolPropertyChanged: function(item, property, oldValue, newValue) { // NewMessages (per folder)
      log.debug("OnItemBoolPropertyChanged "+property+" for folder "+item.prettyName+" was "+oldValue+" became "+newValue+" NEW MESSAGES="+item.getNumNewMessages(true));
      this.onMsgCountChange(item, property, oldValue, newValue);
    },

    OnItemPropertyFlagChanged: function(item, property, oldFlag, newFlag) {
      log.debug("OnItemPropertyFlagChanged"+property+" for "+item+" was "+oldFlag+" became "+newFlag);
      this.onMsgCountChange(item, property, oldFlag, newFlag);
    },

    OnItemEvent: function(item, event) {
      log.debug("OnItemEvent"+event+" for folder "+item.prettyName);
    },

    onMsgCountChange: function(item, property, oldValue, newValue) {
      let excludedFoldersFlags = firetray.Utils.prefService.getIntPref("excluded_folders_flags");
      let onlyFavorites = firetray.Utils.prefService.getBoolPref("only_favorite_folders");
      let msgCountType = firetray.Utils.prefService.getIntPref("message_count_type");

      if (!(item.flags & excludedFoldersFlags)) {
        let prop = property.toString();
        if (prop === "FolderFlag" && onlyFavorites) {
          if ((oldValue ^ newValue) & Ci.nsMsgFolderFlags.Favorite)
            firetray.Messaging.updateMsgCountWithCb();
        } else if (prop === "TotalUnreadMessages" &&
                   msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_UNREAD) {
          firetray.Messaging.updateMsgCountWithCb();
        } else if (prop === "NewMessages" &&
                   msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_NEW) {
          if (oldValue === true && newValue === false)
            item.setNumNewMessages(0); // https://bugzilla.mozilla.org/show_bug.cgi?id=727460
          firetray.Messaging.updateMsgCountWithCb();
        }
      }
    }
  },

  /**
   * @param callback: optional callback to call when msgCount changed.
   */
  updateMsgCountWithCb: function(callback) {
    log.debug("updateMsgCountWithCb");
    if (!this.initialized) return;

    if ("undefined" === typeof(callback) || !callback)
      callback = function(msgCountChanged, newMsgCount) { // default
        firetray.Messaging.updateIcon(newMsgCount);

        if (msgCountChanged) {
          let mailChangeTriggerFile = firetray.Utils.prefService.getCharPref("mail_change_trigger");
          if (mailChangeTriggerFile)
            firetray.Messaging.runProcess(mailChangeTriggerFile, [newMsgCount.toString()]);
        }
      };

    let msgCountType = firetray.Utils.prefService.getIntPref("message_count_type");
    log.debug("msgCountType="+msgCountType);
    if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_UNREAD) {
      this.countMessages("UnreadMessages");
    } else if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_NEW) {
      this.countMessages("HasNewMessages");
    } else
      log.error('unknown message count type');

    let msgCountChanged = (this.newMsgCount !== this.currentMsgCount);
    callback.call(this, msgCountChanged, this.newMsgCount);
    this.currentMsgCount = this.newMsgCount;
  },

  updateIcon: function(msgCount) {
    if ("undefined" === typeof(msgCount)) msgCount = this.currentMsgCount;

    let localizedTooltip;
    let msgCountType = firetray.Utils.prefService.getIntPref("message_count_type");
    if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_UNREAD) {
      localizedTooltip = PluralForm.get(
        msgCount,
        firetray.Utils.strings.GetStringFromName("tooltip.unread_messages"))
        .replace("#1", msgCount);
      log.debug(localizedTooltip);
    } else if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_NEW) {
      localizedTooltip = firetray.Utils.strings.GetStringFromName("tooltip.new_messages");
    } else
      log.error('unknown message count type');

    if (msgCount == 0) {
      firetray.Handler.setIconImageDefault();
      firetray.Handler.setIconTooltipDefault();

    } else if (msgCount > 0) {
      let prefMailNotification = firetray.Utils.prefService.getIntPref('mail_notification_type');
      switch (prefMailNotification) {
      case FIRETRAY_NOTIFICATION_MESSAGE_COUNT:
        let prefIconTextColor = firetray.Utils.prefService.getCharPref("icon_text_color");
        firetray.Handler.setIconText(msgCount.toString(), prefIconTextColor);
        break;
      case FIRETRAY_NOTIFICATION_NEWMAIL_ICON:
        firetray.Handler.setIconImageNewMail();
        break;
      case FIRETRAY_NOTIFICATION_CUSTOM_ICON:
        let prefCustomIconPath = firetray.Utils.prefService.getCharPref("custom_mail_icon");
        firetray.Handler.setIconImageFromFile(prefCustomIconPath);
        break;
      default:
        log.error("Unknown notification mode: "+prefMailNotification);
      }

      firetray.Handler.setIconTooltip(localizedTooltip);

    } else {
      throw "negative message count"; // should never happen
    }
  },

  /**
   * computes total unread or new message count.
   */
  countMessages: function(countType) {
    let mailAccounts = firetray.Utils.getObjPref('mail_accounts');
    log.debug("mail accounts from pref: "+JSON.stringify(mailAccounts));
    let serverTypes = mailAccounts["serverTypes"];
    let excludedAccounts = mailAccounts["excludedAccounts"];

    this.newMsgCount = 0;
    let accounts = new this.Accounts();
    for (let accountServer in accounts) { // nsIMsgAccount

      if (accountServer.type === FIRETRAY_ACCOUNT_SERVER_TYPE_IM) {
        continue;               // IM messages are counted elsewhere
      } else if (!serverTypes[accountServer.type]) {
        log.warn("'"+accountServer.type+"' server type is not handled");
        continue;
      }

      log.debug("is servertype excluded: "+serverTypes[accountServer.type].excluded+", account exclusion index: "+excludedAccounts.indexOf(accountServer.key));
      if ((serverTypes[accountServer.type].excluded) ||
          (excludedAccounts.indexOf(accountServer.key) >= 0))
        continue;

      this.applyToSubfolders(
        accountServer.rootFolder,
        firetray.Utils.prefService.getBoolPref("folder_count_recursive"),
        function(folder){this.msgCountIterate(countType, folder);}
      );

    }
    log.debug("Total "+countType+"="+this.newMsgCount);
  },

  /**
   * @param folder: a nsIMsgFolder
   * @param recursive: if we should look into nested folders
   * @param fun: a function to apply to all folders
   */
  applyToSubfolders: function(folder, recursive, fun) {
    if (folder.hasSubFolders) {
      let subFolders = folder.subFolders;
      while(subFolders.hasMoreElements()) {
        let subFolder = subFolders.getNext().QueryInterface(Ci.nsIMsgFolder);
        if (recursive && subFolder.hasSubFolders)
          firetray.Messaging.applyToSubfoldersRecursive(subFolder, recursive, fun);
        else
          fun.call(this, subFolder);
      }
    }
  },
  applyToSubfoldersRecursive: function(folder, recursive, fun) {
    fun.call(this, folder);
    this.applyToSubfolders(folder, recursive, fun);
  },

  /**
   * @param type: one of 'UnreadMessages', 'HasNewMessages'
   */
  msgCountIterate: function(type, folder) {
    let onlyFavorites = firetray.Utils.prefService.getBoolPref("only_favorite_folders");
    let excludedFoldersFlags = firetray.Utils.prefService.getIntPref("excluded_folders_flags");
    if (!(folder.flags & excludedFoldersFlags)) {
      if (!onlyFavorites || folder.flags & Ci.nsMsgFolderFlags.Favorite) {
        firetray.Messaging["add"+type](folder);
      }
    }
    log.debug("newMsgCount="+this.newMsgCount);
  },

  addUnreadMessages: function(folder) {
    let folderUnreadMsgCount = folder['getNumUnread'](false);
    log.debug("folder: "+folder.prettyName+" folderUnreadMsgCount="+folderUnreadMsgCount);
    /* nsMsgDBFolder::GetNumUnread basically returns mNumUnreadMessages +
      mNumPendingUnreadMessages, while mNumPendingUnreadMessages may get -1
      when updated from the cache. Which means getNumUnread might return -1. */
    if (folderUnreadMsgCount > 0)
      this.newMsgCount += folderUnreadMsgCount;
  },

  addHasNewMessages: function(folder) {
    let folderNewMsgCount = folder.hasNewMessages;
    log.debug("folder: "+folder.prettyName+" hasNewMessages="+folderNewMsgCount);
    this.newMsgCount = this.newMsgCount || folderNewMsgCount;
  },

  runProcess: function(filepath, args) {
    log.debug("runProcess="+filepath+" args="+args);
    try {
      // create a file for the process
      var file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      if (!file.initWithPath)
        file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile); // deprecated in Gecko 14
      file.initWithPath(filepath);

      // create the process
      var process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      process.init(file);

      process.run(false, args, args.length);
    } catch(x) {log.error(x);}
  }

};


/**
 * Accounts Iterator/Generator for iterating over account servers
 * @param sortByTypeAndName: boolean
 */
firetray.Messaging.Accounts = function(sortByTypeAndName) {
  if (typeof(sortByTypeAndName) == "undefined") {
    this.sortByTypeAndName = false;
    return;
  }
  if (typeof(sortByTypeAndName) !== "boolean")
    throw new TypeError();

  this.sortByTypeAndName = sortByTypeAndName;
};

// https://bugzilla.mozilla.org/show_bug.cgi?id=820377
firetray.Messaging._accountsRef = MailServices.accounts.accounts;
if (firetray.Messaging._accountsRef instanceof Ci.nsIArray) {

  function _getAccountServersAsJSArray() {
    let accountServers = [];
    let accEnumerator = firetray.Messaging._accountsRef.enumerate();
    while (accEnumerator.hasMoreElements()) {
      let account = accEnumerator.getNext().QueryInterface(Ci.nsIMsgAccount);
      log.debug("account="+account);
      let accountServer = account.incomingServer;
      accountServers.push(accountServer);
    }
    log.debug("accountServers="+accountServers.length);
    return accountServers;
  }

} else if (firetray.Messaging._accountsRef instanceof Ci.nsISupportsArray) {

  function _getAccountServersAsJSArray() {
    let accountServers = [];
    for (let i=0, len=firetray.Messaging._accountsRef.Count(); i<len; ++i) {
      let account = firetray.Messaging._accountsRef.QueryElementAt(i, Ci.nsIMsgAccount);
      let accountServer = account.incomingServer;
      accountServers[i] = accountServer;
    }
    log.debug("accountServers="+accountServers.length);
    return accountServers;
  }

} else {
    throw TypeError("unknown type for MailServices.accounts.accounts");
}

firetray.Messaging.Accounts.prototype.__iterator__ = function() {
  log.debug("sortByTypeAndName="+this.sortByTypeAndName);

  /* NOTE: sort() not provided by nsIMsgAccountManager.accounts
   (nsISupportsArray or nsIArray if xulrunner >= 20.0). Should be OK to
   re-build a JS-Array for few accounts */
  let accountServers = _getAccountServersAsJSArray();

  let mailAccounts = firetray.Utils.getObjPref('mail_accounts');
  let serverTypes = mailAccounts["serverTypes"];
  if (this.sortByTypeAndName) {
    accountServers.sort(function(a,b) {
      if (serverTypes[a.type].order
          < serverTypes[b.type].order)
        return -1;
      if (serverTypes[a.type].order
          > serverTypes[b.type].order)
        return 1;
      if (a.prettyName < b.prettyName)
        return -1;
      if (a.prettyName > b.prettyName)
        return 1;
      return 0; // no sorting
    });
  }

  for (let i=0, len=accountServers.length; i<len; ++i) {
    log.debug("ACCOUNT: "+accountServers[i].prettyName+" type: "+accountServers[i].type);
    yield accountServers[i];
  }
};

/**
 * return accounts grouped by mail_accounts.
 *
 * ex: { movemail: {"server1", "server2"}, imap: {"server3"} }
 */
firetray.Messaging.accountsByServerType = function() {
  let accountsByServerType = {};
  let accounts = new firetray.Messaging.Accounts(false);
  for (let accountServer in accounts) {
    let accountServerKey = accountServer.key.toString();
    let accountServerName = accountServer.prettyName;
    let accountServerType = accountServer.type;
    if (typeof(accountsByServerType[accountServerType]) == "undefined")
      accountsByServerType[accountServerType] = [];
    accountsByServerType[accountServerType].push(
      { key: accountServerKey, name: accountServerName });
  }
  return accountsByServerType;
};
