import { usePreventRemove } from 'expo-router/react-navigation';
import { useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';

/**
 * 发送正在等附件上传时拦截所有离开方式(顶栏返回、iOS 边缘右滑、Android 返回键)。
 * 离开会丢弃在途上传,这条消息随之放弃发送,先让用户确认。
 */
export function useConfirmLeaveWhileUploading(active: boolean): void {
  const { t } = useTranslation();
  const navigation = useNavigation();
  usePreventRemove(active, ({ data }) => {
    Alert.alert(
      t('session.leaveWhileUploading.title'),
      t('session.leaveWhileUploading.body'),
      [
        { text: t('session.leaveWhileUploading.stay'), style: 'cancel' },
        {
          text: t('session.leaveWhileUploading.discard'),
          style: 'destructive',
          onPress: () => navigation.dispatch(data.action),
        },
      ],
    );
  });
}
