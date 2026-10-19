import { usePreventRemove } from 'expo-router/react-navigation';
import { useNavigation } from 'expo-router';
import { useRef, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';

/**
 * 发送正在等附件上传时拦截所有离开方式(顶栏返回、iOS 边缘右滑、Android 返回键)。
 * 离开会丢弃在途上传,这条消息随之放弃发送,先让用户确认。
 *
 * 返回的 ref 在用户确认放弃的瞬间同步置 true:导航卸载是异步的,上传恰好在这之间
 * 完成时,等待方可能以 abandoned:false 醒来,需据此 ref 一并放弃。
 */
export function useConfirmLeaveWhileUploading(active: boolean): MutableRefObject<boolean> {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const leaveConfirmedRef = useRef(false);
  usePreventRemove(active, ({ data }) => {
    Alert.alert(
      t('session.leaveWhileUploading.title'),
      t('session.leaveWhileUploading.body'),
      [
        { text: t('session.leaveWhileUploading.stay'), style: 'cancel' },
        {
          text: t('session.leaveWhileUploading.discard'),
          style: 'destructive',
          onPress: () => {
            leaveConfirmedRef.current = true;
            navigation.dispatch(data.action);
          },
        },
      ],
    );
  });
  return leaveConfirmedRef;
}
