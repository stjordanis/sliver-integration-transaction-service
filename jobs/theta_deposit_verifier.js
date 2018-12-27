var api = require('../api/api.js');
var logger = require('../utils/logger.js')


//------------------------------------------------------------------------------
//  Global variables
//------------------------------------------------------------------------------
var web3 = null;
var log = null;
var blocksNeeded = 5; // will be overwritten by config
var lock = false;
var timestamp_cutoff = 900; // seconds
var token_contract_address = null;
var token_transfer_method_id = null;
var twenty_four_0s = "000000000000000000000000";

//------------------------------------------------------------------------------
//  All implementation goes below
//------------------------------------------------------------------------------
exports.Initialize = function(config, web3Node, callback) {
  config.log.service_name = 'theta_deposit_verifier';
  log = new logger.Logger(config.log);
  web3 = web3Node;
  blocksNeeded = config.blocks_to_confirm;
  token_contract_address = config.theta_token_contract_address;
  token_transfer_method_id = config.theta_token_transfer_method_id;
}

exports.Execute = function(callback) {
  if (lock) {
    log.Info('Skip..');
    log.Info('===================================================');
    return;
  }
  lock = true;
  var lockOwner = true; 

  api.GetProcessingThetaDepositAsync()
  .then(function (transactionResult) {
    var result = JSON.parse(transactionResult);
    if (result.status == 'SUCCESS') {
      if (result.body.length > 0) {
        transaction = result.body[0];
        xact_id = transaction.id;
        xact_hash = transaction.txhash;
        xact_recipient_id = transaction.recipient;
        xact_timestamp = transaction.timestamp;
        log.Info('Starting to validate deposit: ' + xact_id + ' : ' + xact_recipient_id + ' -> ' + ' : ' + xact_hash)
        return api.GetUserEtherWalletAddressAsync(xact_recipient_id);
      } else {
        throw null;
      }
    } else {
      throw Error('Failed to fetch transactions from backend');
    }
  })
  .then(function (userEtherWalletAddressResult) {
    var result = JSON.parse(userEtherWalletAddressResult);
    if (result.status == 'SUCCESS' && result.body.address != null){
      user_wallet_address = result.body.address;

      // start to verify transaction receipt
      var tx_receipt = web3.eth.getTransactionReceipt(xact_hash);
      var tx_detail = web3.eth.getTransaction(xact_hash)
      if (tx_receipt == null || tx_detail == null) {
        if ((Date.now() - xact_timestamp) / 1000 < timestamp_cutoff) {
          log.Info('Deposit with ' + xact_hash + ' has no receipt yet. Will retry later');
          log.Info('===================================================');
          throw null;
        } else {
          log.Info('Failed to get transaction receipt from blockchain within ' + timestamp_cutoff.toString() + ' seconds');
          payload = {
            status: 'error'
          }
          return api.UpdateThetaTransactionAsync(xact_id, JSON.stringify(payload));
        }
      } else { // tx_receipt and tx_detail are both fetched
        var raw_token_deposit_to_address = (user_wallet_address.startsWith("0x") ? user_wallet_address.substr(2) : user_wallet_address).toLowerCase();
        var currentBlock = web3.eth.blockNumber;
        var receiptBlock = tx_receipt.blockNumber;
        log.Info((currentBlock - receiptBlock + 1).toString() + ' blocks has confirmed this transaction.')

        if (currentBlock - receiptBlock + 1 >=  blocksNeeded) {
          if (tx_receipt.status == '0x1' 
            && tx_detail.to.toLowerCase() == token_contract_address.toLowerCase() // to smart contract
            && tx_detail.input.length == token_transfer_method_id.length + 64 + 64
            && tx_detail.input.startsWith(token_transfer_method_id + twenty_four_0s + raw_token_deposit_to_address)) { // deposit to address in config

            hex_amount_str = "0x" + tx_detail.input.substr(token_transfer_method_id.length + 64);
            decimal_amount_str = web3.toDecimal(hex_amount_str);
            deposit_amount = new web3.BigNumber(decimal_amount_str.toString());
            milli_tokens = Math.floor(deposit_amount.div(Math.pow(10, 15))); // floor to int
              payload = {
                status: 'success',
                tokens: milli_tokens
              }
              log.Info('Verified user deposit. Milli Theta Amount: ' + milli_tokens.toString())
          } else {
            log.Info('User deposit data has failed validity check. ')
            payload = {
              status: 'error'
            }
          }
          return api.UpdateThetaTransactionAsync(xact_id, JSON.stringify(payload)); 
        } else {
          throw null;
        } 
      }
    } else {
      throw Error('Failed to fetch user ether wallet address from backend. ' + xact_recipient_id);
    }
  })
  .then(function(updateTransactionResult) {
    var result = JSON.parse(updateTransactionResult);
    if (result.status == 'SUCCESS') {
      log.Info('Transaction updated .');
      log.Info('===================================================');
      if (lockOwner) {
        lock = false;
      }
    } else {
      throw Error('Failed to update transaction status to backend');
    }

  })
  .catch(function(error) {
    if (error != null) {
      log.Error(error.stack);
      log.Info('Update transaction failed.')
      log.Info('===================================================');
      api.SendSlackMessage(log.ServiceName(), error.message, null, function(err) {if (err!=null) {log.Error('Send slack message failed.')}});
    }

    if (lockOwner) {
      lock = false;
    }

    if (callback != null) {
      callback(error, null);    
    }
  });
}



